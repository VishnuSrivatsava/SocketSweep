#!/usr/bin/env python3
"""Measure production top-K queries on a synthetic scan; no app, ADB or phone.

Requires cached Rust/serde dependencies and macOS/Linux /usr/bin/time.
RSS covers decoding/catalog construction too; it is not isolated query memory.
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
FILES = 250_000
if sys.platform not in ("darwin", "linux"):
    sys.exit("RSS measurement requires macOS or Linux")


def frame(output, kind, data):
    payload = json.dumps({"type": kind, "data": data}, separators=(",", ":")).encode()
    output.write(struct.pack(">I", len(payload)) + payload)


with tempfile.TemporaryDirectory(prefix="socketsweep-largest-bench-") as directory:
    work = Path(directory)
    source = work / "src"
    source.mkdir()
    for name in ("scan_stream.rs", "scan_store.rs"):
        shutil.copy(REPO / "src-tauri/src" / name, source / name)
    versions = {p["name"]: p["version"] for p in tomllib.loads((REPO / "src-tauri/Cargo.lock").read_text())["package"]}
    (work / "Cargo.toml").write_text(f'''[package]
name = "largest-files-benchmark"
version = "0.0.0"
edition = "2021"
[dependencies]
serde = {{ version = "={versions['serde']}", features = ["derive"] }}
serde_json = "={versions['serde_json']}"
''')
    (source / "main.rs").write_text('''const TCP_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
const MAX_COMMAND_BYTES: usize = 16*1024;
mod scan_stream;
mod scan_store;
use std::io::Read;
struct Reader(std::io::BufReader<std::fs::File>);
impl Read for Reader { fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> { self.0.read(bytes) } }
impl scan_stream::StreamReader for Reader {}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let mut reader = Reader(std::io::BufReader::new(std::fs::File::open(&args[1]).unwrap()));
    let response = scan_stream::read(&mut reader, false, |_| Ok(())).unwrap();
    let store = scan_store::Catalog::new(response, "benchmark".into());
    let mut samples = Vec::new();
    let mut bytes = 0;
    if args[2] == "query" {
        for _ in 0..31 {
            let started = std::time::Instant::now();
            let output = store.largest_json("benchmark", 0, 100).unwrap();
            samples.push(started.elapsed().as_secs_f64()*1000.0);
            bytes = output.len();
            let data: serde_json::Value = serde_json::from_str(&output).unwrap();
            assert_eq!(data["files"].as_array().unwrap().len(), 100);
            assert_eq!(data["total_files"], 250000);
        }
    }
    samples.sort_by(f64::total_cmp);
    println!("{}", serde_json::json!({"query_median_ms":samples.get(15), "query_p95_ms":samples.get(29), "ipc_bytes":bytes}));
    std::hint::black_box(store);
}
''')
    stream = work / "fixture.stream"
    with stream.open("wb") as output:
        frame(output, "started", {"stream_version": 1, "root": "/fixture", "read_only": False})
        frame(output, "entries", {"entries": [{"id": 0, "parent": None, "name": "fixture", "kind": "directory", "size": 0, "counted": True}]})
        total = 0
        for offset in range(0, FILES, 128):
            batch = []
            for i in range(offset, min(offset + 128, FILES)):
                size = (i * 7919) % 10_000_000
                total += size
                batch.append({"id": i + 1, "parent": 0, "name": f"file-{i:06}.dat", "kind": "file", "size": size, "counted": True})
            frame(output, "entries", {"entries": batch})
        frame(output, "done", {"total_files": FILES, "total_dirs": 1, "total_size": total,
              "errors": 0, "skipped": 0, "scan_time_ms": 1, "scan_threads": 4,
              "serialize_ms": 0, "send_ms": 0, "bytes_sent": output.tell()})
    subprocess.run(["cargo", "build", "--offline", "--release", "--quiet"], cwd=work, check=True, stderr=subprocess.PIPE)
    results = {"files": FILES, "limit": 100, "samples_per_query_process": 31, "runs": {}}
    for mode in ("load_only", "query"):
        samples = []
        for _ in range(3):
            run = subprocess.run(["/usr/bin/time", "-l" if sys.platform == "darwin" else "-v",
                                  str(work / "target/release/largest-files-benchmark"), str(stream), mode],
                                 check=True, capture_output=True, text=True)
            metrics = json.loads(run.stdout)
            rss = next(line for line in run.stderr.splitlines() if "maximum resident set size" in line.lower())
            metrics["process_peak_rss_bytes"] = int(rss.strip().split()[0]) if sys.platform == "darwin" else int(rss.rsplit(":", 1)[1]) * 1024
            samples.append(metrics)
        results["runs"][mode] = samples
    print(json.dumps(results, indent=2))
