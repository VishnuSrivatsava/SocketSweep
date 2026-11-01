#!/usr/bin/env python3
"""Headless host search benchmark; no app, device, or ADB. Requires Rust.

Builds a large catalog from the production scan_stream/scan_store sources,
then measures search response times across query shapes, full pagination
cost, and host peak RSS via /usr/bin/time. Correctness is verified against
match counts computed independently in this script.
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

FILES = 86_666
DIRS = 32
NEEDLE_EVERY = 97


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


with tempfile.TemporaryDirectory(prefix="socketsweep-search-bench-") as directory:
    work = Path(directory)
    source = work / "src"
    source.mkdir()
    shutil.copy(REPO / "src-tauri/src/scan_stream.rs", source / "scan_stream.rs")
    shutil.copy(REPO / "src-tauri/src/scan_store.rs", source / "scan_store.rs")
    lock = tomllib.loads((REPO / "src-tauri/Cargo.lock").read_text())
    versions = {package["name"]: package["version"] for package in lock["package"]}
    (work / "Cargo.toml").write_text(f'''[package]
name = "socketsweep-search-benchmark"
version = "0.0.0"
edition = "2021"
[dependencies]
serde = {{ version = "={versions['serde']}", features = ["derive"] }}
serde_json = {{ version = "={versions['serde_json']}" }}
[[bin]]
name = "search-bench"
path = "src/main.rs"
''')
    expected_matches = len(range(0, FILES, NEEDLE_EVERY))
    (source / "main.rs").write_text(f'''const MAX_COMMAND_BYTES: usize = 16*1024;
const TCP_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
mod scan_stream;
mod scan_store;
use std::io::{{Read, Write}};
struct Reader(std::io::BufReader<std::fs::File>);
impl Read for Reader {{ fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {{ self.0.read(bytes) }} }}
impl scan_stream::StreamReader for Reader {{}}
fn timed(report: &mut serde_json::Map<String, serde_json::Value>, name: &str, query: impl FnOnce() -> String) -> String {{
    let started = std::time::Instant::now();
    let payload = query();
    report.insert(name.to_string(), serde_json::json!({{
        "ms": started.elapsed().as_secs_f64()*1000.0, "response_bytes": payload.len() }}));
    payload
}}
fn main() {{
    let args: Vec<_> = std::env::args().collect();
    let expected_matches: usize = args[2].parse().unwrap();
    let started = std::time::Instant::now();
    let mut reader = Reader(std::io::BufReader::new(std::fs::File::open(&args[1]).unwrap()));
    let response = scan_stream::read(&mut reader, false, |_| Ok(())).unwrap();
    let mut report = serde_json::Map::new();
    let store = scan_store::Catalog::new(response, "a".repeat(64));
    report.insert("ingest_ms".into(), serde_json::json!(started.elapsed().as_secs_f64()*1000.0));
    let generation = "a".repeat(64);
    // ASCII-folded query over ~{expected_matches} scattered matches, then every page.
    timed(&mut report, "fold_first_page", || store.search_json(&generation, 0, "NEEDLE", 0).unwrap());
    let mut page = 0usize;
    loop {{
        let value: serde_json::Value = serde_json::from_str(&store.search_json(&generation, 0, "NEEDLE", page as u32).unwrap()).unwrap();
        let results = value["results"].as_array().unwrap().len();
        page += results;
        if !value["has_more"].as_bool().unwrap() {{ break; }}
    }}
    assert_eq!(page, expected_matches, "pagination must reach every match");
    // Worst-case deep skip over the common matches: the scan restarts each
    // page, so a page near the end re-checks every earlier entry.
    timed(&mut report, "common_first_page", || store.search_json(&generation, 0, "file-0", 0).unwrap());
    let common_matches = 86_666usize - expected_matches;
    let deep: serde_json::Value = serde_json::from_str(&timed(
        &mut report, "common_deep_skip",
        || store.search_json(&generation, 0, "file-0", (common_matches - 100) as u32).unwrap(),
    )).unwrap();
    assert_eq!(deep["results"].as_array().unwrap().len(), 100);
    assert_eq!(deep["has_more"], false);
    timed(&mut report, "no_match", || store.search_json(&generation, 0, "zzz-no-match", 0).unwrap());
    std::fs::File::create(&args[3]).unwrap().write_all(serde_json::to_string_pretty(&report).unwrap().as_bytes()).unwrap();
}}''')
    stream = work / "fixture.stream"
    entries = [{"id": 0, "parent": None, "name": "fixture", "kind": "directory", "size": 0, "counted": True}]
    entries += [{"id": i + 1, "parent": 0, "name": f"folder-{i:02}", "kind": "directory", "size": 0, "counted": True} for i in range(DIRS)]
    total = 0
    for i in range(FILES):
        size = (i * 7919) % 10_000_000
        total += size
        name = f"needle-{i:06}.log" if i % NEEDLE_EVERY == 0 else f"file-{i:06}.dat"
        entries.append({"id": i + DIRS + 1, "parent": i % DIRS + 1, "name": name, "kind": "file", "size": size, "counted": True})
    with stream.open("wb") as output:
        frame(output, "started", {"stream_version": 1, "root": "/fixture", "read_only": False})
        for offset in range(0, len(entries), 128):
            frame(output, "entries", {"entries": entries[offset:offset + 128]})
        frame(output, "done", {"total_files": FILES, "total_dirs": DIRS + 1, "total_size": total,
                               "errors": 0, "skipped": 0, "scan_time_ms": 1, "scan_threads": 4,
                               "serialize_ms": 0, "send_ms": 0, "bytes_sent": output.tell()})
    run("cargo", "build", "--offline", "--release", cwd=work, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    samples = []
    for _ in range(3):
        measurement = run("/usr/bin/time", "-l" if sys.platform == "darwin" else "-v",
                          str(work / "target/release/search-bench"), str(stream), str(expected_matches),
                          str(work / "report.json"), capture_output=True)
        lines = measurement.stderr.splitlines()
        rss = next(line for line in lines if "maximum resident set size" in line.lower())
        peak = int(rss.strip().split()[0]) if sys.platform == "darwin" else int(rss.rsplit(":", 1)[1]) * 1024
        report = json.loads((work / "report.json").read_text())
        report["host_max_rss_bytes"] = peak
        samples.append(report)
    results = {"files": FILES, "directories": DIRS + 1, "expected_matches": expected_matches, "runs": samples}
    assert all(run["fold_first_page"]["response_bytes"] == samples[0]["fold_first_page"]["response_bytes"] for run in samples)
    assert samples[0]["no_match"]["response_bytes"] < 200
    results["verified"] = "full NEEDLE pagination reaches every expected match; no-match page is empty"
    print(json.dumps(results, indent=2))
