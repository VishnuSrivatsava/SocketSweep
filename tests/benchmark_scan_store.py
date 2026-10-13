#!/usr/bin/env python3
"""Headless host comparison; no app, device, or ADB. Requires Rust and Node.

Runs the pinned pre-store decoder and current production store on identical
stream-v1 bytes. Output includes initial IPC, host time/RSS, and Node memory.
The temporary Rust harness uses the repository's existing serde dependencies.
"""
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import tomllib

REPO = Path(__file__).resolve().parents[1]
if sys.platform not in ("darwin", "linux"):
    sys.exit("RSS benchmark requires macOS or Linux /usr/bin/time")

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


with tempfile.TemporaryDirectory(prefix="socketsweep-store-bench-") as directory:
    work = Path(directory)
    source = work / "src"
    source.mkdir()
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
    let response = scan_stream::read(&mut reader, false, |_| Ok(())).unwrap();
'''
    (source / "baseline.rs").write_text('#[path="baseline_stream.rs"] mod scan_stream;\n' + common + '''
    let payload = response.json().unwrap();
    std::fs::File::create(&args[2]).unwrap().write_all(payload.as_bytes()).unwrap();
    println!("{}", serde_json::json!({"ipc_bytes":payload.len(),"host_ms":started.elapsed().as_secs_f64()*1000.0}));
}
''')
    (source / "current.rs").write_text('const MAX_COMMAND_BYTES: usize = 16*1024;\nmod scan_stream;\nmod scan_store;\n' + common + '''
    let store = scan_store::Catalog::new(response, "a".repeat(64));
    let summary = store.summary_json().unwrap();
    let root = store.view_json(&"a".repeat(64), 0, 0, None).unwrap();
    let page = store.view_json(&"a".repeat(64), 0, 1, None).unwrap();
    let payload = format!("[{summary},{root},{page}]");
    std::fs::File::create(&args[2]).unwrap().write_all(payload.as_bytes()).unwrap();
    println!("{}", serde_json::json!({"ipc_bytes":summary.len()+root.len()+page.len(),"host_ms":started.elapsed().as_secs_f64()*1000.0}));
}
''')
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
            command = ["/usr/bin/time", "-l" if sys.platform == "darwin" else "-v", str(work / "target/release" / mode), str(stream), str(output)]
            measurement = run(*command, capture_output=True)
            metrics = json.loads(measurement.stdout)
            lines = measurement.stderr.splitlines()
            rss = next(line for line in lines if "maximum resident set size" in line.lower())
            metrics["host_max_rss_bytes"] = int(rss.strip().split()[0]) if sys.platform == "darwin" else int(rss.rsplit(":", 1)[1]) * 1024
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
