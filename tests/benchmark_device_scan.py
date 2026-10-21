#!/usr/bin/env python3
"""Opt-in Android worker benchmark using the application's Rust session/decoder.

Nothing contacts ADB on import or --help. This script runs the ignored live
experiment only after explicit serial selection. Offline tests mock Cargo.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[1]
TEST = "scan_benchmark::connected_device"


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def benchmark(serial, root="/sdcard", output=None, adb=None, daemon=None):
    if not serial or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in serial):
        raise ValueError("Choose an explicit device serial without whitespace/control characters")
    if not root.startswith("/") or any(c in root for c in "\r\n\0") or len(root.encode()) + len("SCAN_STREAM ") > 16 * 1024:
        raise ValueError("Choose an absolute scan path without line breaks, within 16 KiB")
    adb = Path(adb or REPO / "src-tauri/bin" / ("adb.exe" if os.name == "nt" else "adb")).resolve(strict=True)
    daemon = Path(daemon or REPO / "src-tauri/bin/daemon").resolve(strict=True)
    if not adb.is_file() or not daemon.is_file():
        raise ValueError("ADB and daemon must be files")
    if output is None:
        output = Path(tempfile.mkdtemp(prefix="socketsweep-scan-benchmark-"))
    else:
        output = Path(output).resolve()
        output.mkdir(mode=0o700)  # Never overwrite another experiment.
    print(f"Results directory: {output}", flush=True)
    print("Four warm-ups, then five mixed-order scans per worker count. Keep storage unchanged.", flush=True)
    with tempfile.TemporaryDirectory(prefix="socketsweep-scan-artifact-") as directory:
        # All four sessions receive the exact same immutable local snapshot,
        # even if the original build output is replaced during the experiment.
        snapshot = Path(directory) / "daemon"
        shutil.copyfile(daemon, snapshot)
        fingerprint = digest(snapshot)
        env = os.environ.copy()
        env.update(SOCKETSWEEP_DEVICE_BENCH="1", SOCKETSWEEP_BENCH_SERIAL=serial,
                   SOCKETSWEEP_BENCH_ROOT=root.rstrip("/") or "/", SOCKETSWEEP_BENCH_ADB=str(adb),
                   SOCKETSWEEP_BENCH_DAEMON=str(snapshot), SOCKETSWEEP_BENCH_OUTPUT=str(output))
        command = ["cargo", "test", "--release", "--locked", "--manifest-path", str(REPO / "src-tauri/Cargo.toml"),
                   "--lib", TEST, "--", "--ignored", "--exact", "--nocapture"]
        group = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        process = subprocess.Popen(command, cwd=REPO, env=env, stdin=subprocess.PIPE, **group)
        try:
            status = process.wait()
        except KeyboardInterrupt:
            # Rust watches this pipe and interrupts its active scan socket.
            # Shielding Cargo from terminal SIGINT allows owned-session cleanup.
            process.stdin.close()
            print("Cancelling; waiting for bounded session cleanup...", file=sys.stderr, flush=True)
            try:
                process.wait(timeout=90)
            except subprocess.TimeoutExpired:
                process.terminate()  # only this wrapper's owned Cargo child
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                print("Cleanup timed out; private session files/forwards may remain.", file=sys.stderr)
            raise
        finally:
            if not process.stdin.closed:
                process.stdin.close()
        if status:
            raise RuntimeError(f"Experiment failed (Cargo exit {status}). Inspect {output}; no verified result.json was created.")
        with (output / "measurements.json").open(encoding="utf-8") as stream:
            report = json.load(stream)
        if report.get("verified") is not True:
            raise ValueError("Experiment did not produce verified measurements")
        report["daemon_sha256"] = fingerprint
        with (output / "result.json").open("x", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2, allow_nan=False)
            stream.write("\n")
        print("\nWorkers | median scan ms | median stream round-trip ms", flush=True)
        for row in report["medians"]:
            print(f"{row['workers']:7} | {row['scan_ms']:14.1f} | {row['stream_wall_ms']:27.1f}", flush=True)
        print(f"\nShare this file after reviewing it: {output / 'result.json'}", flush=True)
        return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--root", default="/sdcard", help="Existing directory to scan; keep its contents unchanged")
    parser.add_argument("--output", type=Path, help="New result directory; parent must exist")
    parser.add_argument("--adb", type=Path, help="Host ADB executable; defaults to bundled resource")
    parser.add_argument("--daemon", type=Path, help="Android daemon; defaults to bundled resource")
    args = parser.parse_args()
    try:
        benchmark(args.serial, args.root, args.output, args.adb, args.daemon)
    except KeyboardInterrupt:
        parser.exit(130, "Benchmark cancelled; no verified result.json was created.\n")
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f"Benchmark failed: {error}\n")


if __name__ == "__main__":
    main()
