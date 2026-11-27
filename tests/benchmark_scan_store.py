#!/usr/bin/env python3
"""Headless host comparison; no app, device, or ADB. Requires Rust and Node.

Runs the pinned pre-store decoder and current production store on identical
stream-v1 bytes. Output includes initial IPC, host time/RSS, and Node memory.
The temporary Rust harness uses the repository's existing serde dependencies.
With --capacity, measure the current decoder and store across larger fixtures.
"""
import argparse
import json
import os
import platform
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import tomllib

REPO = Path(__file__).resolve().parents[1]
if sys.platform not in ("darwin", "linux"):
    sys.exit("RSS benchmark requires macOS or Linux")

BASELINE = "9326b4221adb410c3cbf8562e2777471a4c30083"
FILES = 86_666
DIRS = 32


def run(*args, **kwargs):
    try:
        return subprocess.run(args, check=True, text=True, **kwargs)
    except subprocess.CalledProcessError as error:
        if error.stderr:
            print(error.stderr[-4000:], file=sys.stderr)
        raise


def frame(output, kind, data):
    payload = json.dumps({"type": kind, "data": data}, ensure_ascii=False, separators=(",", ":")).encode()
    output.write(struct.pack(">I", len(payload)))
    output.write(payload)


def measure_host(binary, stream, output, *args):
    # wait4 reports the child peak directly, including on macOS hosts where
    # /usr/bin/time -l cannot read kern.clockrate.
    with tempfile.TemporaryFile(mode="w+t") as stdout, tempfile.TemporaryFile(mode="w+t") as stderr:
        with subprocess.Popen([str(binary), str(stream), str(output), *args], stdout=stdout, stderr=stderr) as child:
            _, status, usage = os.wait4(child.pid, 0)
            child.returncode = os.waitstatus_to_exitcode(status)
            stdout.seek(0)
            stderr.seek(0)
            result = subprocess.CompletedProcess(child.args, child.returncode, stdout.read(), stderr.read())
    rss_bytes = usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024
    return result, rss_bytes


def write_capacity_fixture(stream, files, folders):
    sparse = folders is None
    names = ["fixture", *(folders or [])]
    directories = [
        {"id": index, "parent": index - 1 if index else None, "name": name,
         "kind": "directory", "size": 0, "counted": True}
        for index, name in enumerate(names)
    ]
    total_dirs = files + 1 if sparse else len(names)
    files_per_batch = 64 if sparse else 128
    with stream.open("wb") as output:
        frame(output, "started", {"stream_version": 1, "root": "/fixture", "read_only": False})
        frame(output, "entries", {"entries": directories})
        for offset in range(0, files, files_per_batch):
            entries = []
            for index in range(offset, min(files, offset + files_per_batch)):
                if sparse:
                    parent = index * 2 + 1
                    entries.append({"id": parent, "parent": 0, "name": f"folder-{index:06}",
                                    "kind": "directory", "size": 0, "counted": True})
                    file_id, name = parent + 1, "file-000000.dat"
                else:
                    parent = len(names) - 1
                    file_id, name = index + len(names), f"file-{index:06}.dat"
                entries.append({"id": file_id, "parent": parent, "name": name,
                                "kind": "file", "size": 1, "counted": True})
            frame(output, "entries", {"entries": entries})
        frame(output, "done", {"total_files": files, "total_dirs": total_dirs, "total_size": files,
              "errors": 0, "skipped": 0, "scan_time_ms": 1, "scan_threads": 4,
              "serialize_ms": 0, "send_ms": 0, "bytes_sent": output.tell()})
    return total_dirs


def measure_capacity(work):
    stream = work / "fixture.stream"
    output = work / "capacity.json"
    binary = work / "target/release/current"
    nested = ["folder-" + "d" * 25] * 4
    cases = [
        ("wide", 360_000, ["folder-00"]),
        ("nested", 300_000, nested),
        ("nested-large", 360_000, nested),
        ("deep", 360_000, nested * 4),
        ("wide-near-budget", 460_000, ["folder-00"]),
        ("wide-over-budget", 480_000, ["folder-00"]),
        ("sparse", 210_000, None),
        ("sparse-over-budget", 230_000, None),
    ]
    reports = []
    for label, files, folders in cases:
        total_dirs = write_capacity_fixture(stream, files, folders)
        sample_folders = folders if folders is not None else ["folder-000000"]
        leaf_files = files if folders is not None else 1
        samples = []
        for _ in range(3):
            result, rss = measure_host(binary, stream, output, str(len(sample_folders)))
            if result.returncode:
                error = result.stderr.strip()
                if result.returncode != 1 or not error.startswith("Scan reached the desktop indexing limit after "):
                    print(error[-4000:], file=sys.stderr)
                    result.check_returncode()
                samples.append({"status": "budget_exceeded", "error": error, "host_max_rss_bytes": rss})
                continue
            summary, root, page = json.loads(output.read_text())
            if (summary["total_files"], summary["total_dirs"], summary["total_size"]) != (files, total_dirs, files):
                raise ValueError(f"{label}: unexpected scan totals")
            if page["path"] != "/fixture/" + "/".join(sample_folders):
                raise ValueError(f"{label}: unexpected folder path")
            if [entry["name"] for entry in page["children"]] != [f"file-{index:06}.dat" for index in range(min(leaf_files, 128))]:
                raise ValueError(f"{label}: unexpected first page")
            if sum(tile["size"] for tile in root["chart"]) != files or sum(tile["size"] for tile in page["chart"]) != leaf_files:
                raise ValueError(f"{label}: unexpected chart totals")
            samples.append({"status": "completed", "host_max_rss_bytes": rss, **json.loads(result.stdout)})
        if len({sample["status"] for sample in samples}) != 1:
            raise ValueError(f"{label}: inconsistent runs")
        reports.append({"fixture": label, "files": files, "folders": total_dirs,
                        "sample_directory_segments": sample_folders, "runs": samples})
    print(json.dumps({"platform": platform.platform(), "rustc": run("rustc", "--version", capture_output=True).stdout.strip(),
                      "fixtures": reports}, indent=2))


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--capacity", action="store_true", help="measure the current store on larger fixtures")
args = parser.parse_args()


with tempfile.TemporaryDirectory(prefix="socketsweep-store-bench-") as directory:
    work = Path(directory)
    source = work / "src"
    source.mkdir()
    if not args.capacity:
        (source / "baseline_stream.rs").write_text(run("git", "show", f"{BASELINE}:src-tauri/src/scan_stream.rs", cwd=REPO, capture_output=True).stdout)
    shutil.copy(REPO / "src-tauri/src/scan_stream.rs", source / "scan_stream.rs")
    shutil.copy(REPO / "src-tauri/src/scan_store.rs", source / "scan_store.rs")
    # Pin the versions in the app lockfile, then reuse its downloaded cache.
    lock = tomllib.loads((REPO / "src-tauri/Cargo.lock").read_text())
    versions = {package["name"]: package["version"] for package in lock["package"]}
    (work / "Cargo.toml").write_text('''[package]
name = "socketsweep-store-benchmark"
version = "0.0.0"
edition = "2021"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
[[bin]]
name = "baseline"
path = "src/baseline.rs"
[[bin]]
name = "current"
path = "src/current.rs"
'''.replace('version = "1", features', 'version = "=' + versions['serde'] + '", features').replace('serde_json = "1"', 'serde_json = "=' + versions['serde_json'] + '"'))
    common = '''const TCP_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
use std::io::{Read, Write};
struct Reader(std::io::BufReader<std::fs::File>);
impl Read for Reader { fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> { self.0.read(bytes) } }
impl scan_stream::StreamReader for Reader {}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let started = std::time::Instant::now();
    let mut reader = Reader(std::io::BufReader::new(std::fs::File::open(&args[1]).unwrap()));
    let response = scan_stream::read(&mut reader, false, |_| Ok(())).unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(1);
    });
'''
    (source / "baseline.rs").write_text('#[path="baseline_stream.rs"] mod scan_stream;\n' + common + '''
    let payload = response.json().unwrap();
    std::fs::File::create(&args[2]).unwrap().write_all(payload.as_bytes()).unwrap();
    println!("{}", serde_json::json!({"ipc_bytes":payload.len(),"host_ms":started.elapsed().as_secs_f64()*1000.0}));
}
''')
    (source / "current.rs").write_text('const MAX_COMMAND_BYTES: usize = 16*1024;\nmod scan_stream;\nmod scan_store;\n' + common + '''
    let decode_ms = started.elapsed().as_secs_f64() * 1000.0;
    let generation = "a".repeat(64);
    let folder_id = args.get(3).map(|id| id.parse::<u32>().unwrap()).unwrap_or(1);
    let indexing_started = std::time::Instant::now();
    let store = scan_store::Catalog::new(response, generation.clone());
    let index_ms = indexing_started.elapsed().as_secs_f64() * 1000.0;
    let queries_started = std::time::Instant::now();
    let summary = store.summary_json().unwrap();
    let root = store.view_json(&generation, 0, 0, None).unwrap();
    let page = store.view_json(&generation, 0, folder_id, None).unwrap();
    let ipc_query_ms = queries_started.elapsed().as_secs_f64() * 1000.0;
    let payload = format!("[{summary},{root},{page}]");
    std::fs::File::create(&args[2]).unwrap().write_all(payload.as_bytes()).unwrap();
    println!("{}", serde_json::json!({"ipc_bytes":summary.len()+root.len()+page.len(),
        "host_ms":started.elapsed().as_secs_f64()*1000.0, "decode_ms":decode_ms,
        "index_ms":index_ms,"ipc_query_ms":ipc_query_ms}));
}
''')
    if args.capacity:
        run("cargo", "build", "--offline", "--release", "--bin", "current", cwd=work,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        measure_capacity(work)
        sys.exit(0)

    stream = work / "fixture.stream"
    entries = [{"id": 0, "parent": None, "name": "fixture", "kind": "directory", "size": 0, "counted": True}]
    entries += [{"id": i+1, "parent": 0, "name": f"folder-{i:02}", "kind": "directory", "size": 0, "counted": True} for i in range(DIRS)]
    total = 0
    for i in range(FILES):
        size = (i * 7919) % 10_000_000
        total += size
        entries.append({"id": i+DIRS+1, "parent": i % DIRS+1, "name": f"file-{i:06}.dat", "kind": "file", "size": size, "counted": True})
    with stream.open("wb") as output:
        frame(output, "started", {"stream_version": 1, "root": "/fixture", "read_only": False})
        for offset in range(0, len(entries), 128):
            frame(output, "entries", {"entries": entries[offset:offset+128]})
        frame(output, "done", {"total_files": FILES, "total_dirs": DIRS+1, "total_size": total,
              "errors": 0, "skipped": 0, "scan_time_ms": 1, "scan_threads": 4,
              "serialize_ms": 0, "send_ms": 0, "bytes_sent": output.tell()})
    run("cargo", "build", "--offline", "--release", cwd=work, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    results = {"baseline_commit": BASELINE, "files": FILES, "directories": DIRS+1, "total_size": total, "runs": {}}
    node = work / "memory.mjs"
    node.write_text('''import fs from "node:fs";
import v8 from "node:v8";
global.gc();
const initialHeap = v8.getHeapStatistics().used_heap_size;
const start = performance.now();
const raw = fs.readFileSync(process.argv[2], "utf8");
const data = JSON.parse(raw);
const parseMs = performance.now() - start;
let cloneMs = null;
let copy;
if (process.argv[3] === "baseline") {
  const started = performance.now();
  copy = JSON.parse(JSON.stringify(data));
  cloneMs = performance.now() - started;
}
console.log(JSON.stringify({parse_ms:parseMs, clone_ms:cloneMs,
  heap_delta_bytes:v8.getHeapStatistics().used_heap_size-initialHeap,
  max_rss_kib:process.resourceUsage().maxRSS}));
// Retain the objects through measurement, as the frontend's before/after trees.
if (!data || (process.argv[3] === "baseline" && !copy)) throw Error("missing data");
''')
    for mode in ["baseline", "current"]:
        output = work / f"{mode}.json"
        samples = []
        for _ in range(3):
            measurement, rss = measure_host(work / "target/release" / mode, stream, output)
            if measurement.returncode:
                print(measurement.stderr[-4000:], file=sys.stderr)
                measurement.check_returncode()
            metrics = json.loads(measurement.stdout)
            metrics["host_max_rss_bytes"] = rss
            metrics["javascript"] = json.loads(run("node", "--expose-gc", str(node), str(output), mode, capture_output=True).stdout)
            samples.append(metrics)
        results["runs"][mode] = samples
    baseline = json.loads((work / "baseline.json").read_text())
    current = json.loads((work / "current.json").read_text())
    for key in ["total_files", "total_dirs", "total_size"]:
        assert baseline[key] == current[0][key]
    expected = next(child for child in baseline["tree"]["children"] if child["name"] == "folder-00")
    assert current[2]["node"]["size"] == expected["size"]
    assert [child["name"] for child in current[2]["children"]] == [child["name"] for child in expected["children"][:128]]
    assert sum(tile["size"] for tile in current[2]["chart"]) == expected["size"]
    results["verified"] = "totals, sample directory ordering, and exact treemap sum"
    print(json.dumps(results, indent=2))
