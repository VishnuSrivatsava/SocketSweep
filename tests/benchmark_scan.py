"""Compare authenticated daemon scans on a disposable host fixture.

Example: python3 tests/benchmark_scan.py /tmp/new-daemon --baseline /tmp/old-daemon
Run as an ordinary user: UID 0 deliberately forces the daemon's serial root mode.
This measures warm-cache host traversal/JSON transfer, not Android performance.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import secrets
import socket
import statistics
import subprocess
import tempfile
import time


def fingerprint(result):
    """Compare paths/types/sizes and all counters, independently of child order."""
    entries = []
    pending = [result["tree"]]
    while pending:
        node = pending.pop()
        entries.append((node["path"], node["type"], node["size"]))
        pending.extend(node.get("children", []))
    counters = {key: result[key] for key in
                ["total_files", "total_dirs", "total_size", "errors", "skipped", "read_only"]}
    return hashlib.sha256(json.dumps([counters, sorted(entries)], ensure_ascii=True).encode()).hexdigest()


class Daemon:
    def __init__(self, binary, work, threads):
        self.token = secrets.token_hex(32)
        token_file = work / ("token-" + self.token[:8])
        token_file.write_text(self.token + "\n")
        token_file.chmod(0o600)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        args = [str(binary), str(self.port), str(token_file)]
        if threads is not None:
            args.extend(["--threads", str(threads)])
        self.process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for attempt in range(100):
                try:
                    self.command("PING")
                    return
                except OSError:
                    if self.process.poll() is not None:
                        raise RuntimeError("Daemon exited during startup")
                    time.sleep(0.01)
            raise RuntimeError("Daemon startup timed out")
        except BaseException:
            self.close()
            raise

    def command(self, command):
        with socket.create_connection(("127.0.0.1", self.port), timeout=120) as client:
            client.sendall(f"AUTH {self.token}\n{command}\n".encode())
            data = bytearray()
            while chunk := client.recv(256 * 1024):
                data.extend(chunk)
        result = json.loads(data)
        if result["status"] != "ok":
            raise RuntimeError(result)
        return result, len(data)

    def close(self):
        if self.process.poll() is None:
            try:
                self.command("SHUTDOWN")
                self.process.wait(timeout=5)
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    if os.geteuid() == 0 or args.repeats < 1:
        parser.error("Use an ordinary user and at least one repeat")
    with tempfile.TemporaryDirectory(prefix="socketsweep-benchmark-") as directory:
        work = Path(directory)
        root = work / "storage"
        root.mkdir()
        for album in range(200):
            child = root / f"album_{album:03}"
            child.mkdir()
            for index in range(200):
                with (child / f"file_{index:03}").open("wb") as file:
                    file.truncate(1024 + index)
        daemons = {}
        results = []
        try:
            if args.baseline:
                daemons["baseline"] = Daemon(args.baseline.resolve(), work, None)
            for workers in [1, 2, 4, 8]:
                daemons[str(workers)] = Daemon(args.binary.resolve(), work, workers)
            reference = None
            for daemon in daemons.values():
                result, _ = daemon.command(f"SCAN {root}")
                assert result["total_files"] == 40000 and result["total_dirs"] == 201
                assert result["total_size"] == 44940000 and result["errors"] == 0
                digest = fingerprint(result)
                reference = reference or digest
                assert digest == reference, "Warm-up tree differs"
            trials = list(daemons) * args.repeats
            random.Random(27).shuffle(trials)
            for mode in trials:
                start = time.perf_counter()
                result, wire_bytes = daemons[mode].command(f"SCAN {root}")
                wall_ms = (time.perf_counter() - start) * 1000
                assert fingerprint(result) == reference, "Measured scan differs"
                row = {key: result[key] for key in ["scan_time_ms", "traverse_ms", "sort_ms",
                                                   "serialize_ms", "send_ms", "total_files",
                                                   "total_dirs", "total_size", "errors"]}
                row.update(mode=mode, wall_ms=wall_ms, wire_bytes=wire_bytes)
                results.append(row)
            for mode in daemons:
                samples = [row for row in results if row["mode"] == mode]
                summary = {key: round(statistics.median(row[key] for row in samples), 3)
                           for key in samples[0] if key != "mode"}
                print(mode, json.dumps(summary), flush=True)
            if args.output:
                args.output.write_text(json.dumps(results, indent=2) + "\n")
        finally:
            for daemon in daemons.values():
                daemon.close()


if __name__ == "__main__":
    main()
