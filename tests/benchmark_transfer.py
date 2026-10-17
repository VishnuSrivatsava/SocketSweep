#!/usr/bin/env python3
"""Disposable ADB/MTP download baseline. Nothing contacts a device on import.

Only `pull` invokes ADB. Fixture upload and cleanup are manual. This is a
trusted-local-filesystem experiment, not the application's export implementation.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid

MIB = 1024 * 1024
WORKLOADS = ("large", "small")


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def prepare(workspace, large_mib=64, small_count=1000):
    if not 1 <= large_mib <= 1024 or not 1 <= small_count <= 5000:
        raise ValueError("Use 1–1024 large MiB and 1–5000 small files")
    workspace.mkdir()  # Never reuse or overwrite an existing experiment.
    name = "SocketSweep-benchmark-" + uuid.uuid4().hex
    root = workspace / name
    records = {}
    for workload in WORKLOADS:
        (root / workload).mkdir(parents=True)
        sizes = [large_mib * MIB] if workload == "large" else [4096] * small_count
        for index, size in enumerate(sizes):
            relative = f"{workload}/file-{index:06d}.bin"
            digest = hashlib.sha256()
            with (root / relative).open("xb") as stream:
                remaining = size
                while remaining:
                    block = os.urandom(min(MIB, remaining))
                    stream.write(block)
                    digest.update(block)
                    remaining -= len(block)
            records[relative] = {"bytes": size, "sha256": digest.hexdigest()}
    manifest = {"version": 1, "fixture": name, "files": records}
    write_json(workspace / "manifest.json", manifest)
    return manifest


def load_manifest(workspace):
    with (workspace / "manifest.json").open("rb") as stream:
        encoded = stream.read(2 * MIB + 1)
    if len(encoded) > 2 * MIB:
        raise ValueError("Manifest exceeds 2 MiB")
    manifest = json.loads(encoded)
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise ValueError("Unsupported manifest")
    if not re.fullmatch(r"SocketSweep-benchmark-[0-9a-f]{32}", str(manifest.get("fixture"))):
        raise ValueError("Invalid fixture name")
    files = manifest.get("files")
    if not isinstance(files, dict) or not 2 <= len(files) <= 5001:
        raise ValueError("Invalid file count")
    for path, entry in files.items():
        if not re.fullmatch(r"(?:large|small)/file-[0-9]{6}\.bin", path):
            raise ValueError("Invalid fixture path")
        if not isinstance(entry, dict):
            raise ValueError("Invalid file record")
        size = entry.get("bytes")
        if type(size) is not int or not 1 <= size <= 1024 * MIB:
            raise ValueError("Invalid file size")
        if not re.fullmatch(r"[0-9a-f]{64}", str(entry.get("sha256"))):
            raise ValueError("Invalid SHA-256")
    large = {path for path in files if path.startswith("large/")}
    small = sorted(path for path in files if path.startswith("small/"))
    if (large != {"large/file-000000.bin"} or not small or
            small != [f"small/file-{i:06d}.bin" for i in range(len(small))] or
            any(files[path]["bytes"] != 4096 for path in small)):
        raise ValueError("Invalid workload layout")
    return manifest


def verify_copy(manifest, workload, copy):
    """Require exact contents, regular files only, and matching sizes/hashes."""
    if workload not in WORKLOADS:
        raise ValueError("Unknown workload")
    if copy.is_symlink() or not copy.is_dir():
        raise ValueError("Copy must be a real workload directory")
    expected = {path.split("/", 1)[1]: entry for path, entry in manifest["files"].items()
                if path.startswith(workload + "/")}
    if {path.name for path in copy.iterdir()} != set(expected):
        raise ValueError("Copy has missing or unexpected entries")
    total = 0
    for name, entry in expected.items():
        path = copy / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size != entry["bytes"]:
            raise ValueError(f"Wrong file type or size: {name}")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(MIB), b""):
                digest.update(block)
        if digest.hexdigest() != entry["sha256"]:
            raise ValueError(f"SHA-256 mismatch: {name}")
        total += info.st_size
    return len(expected), total


def result(manifest, workload, copy, seconds, backend, compression):
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("Transfer seconds must be finite and positive")
    start = time.perf_counter()
    count, size = verify_copy(manifest, workload, copy)
    return {"fixture": manifest["fixture"], "workload": workload,
            "backend": backend, "compression": compression, "verified": True,
            "files": count, "bytes": size, "transfer_seconds": seconds,
            "verification_seconds": time.perf_counter() - start,
            "mib_per_second": size / MIB / seconds}


def pull(workspace, serial, workload, output, compression="none", adb="adb"):
    manifest = load_manifest(workspace)
    if workload not in WORKLOADS or compression not in ("none", "any"):
        raise ValueError("Invalid workload or compression")
    if not serial or serial.strip() != serial or any(ord(c) < 33 for c in serial):
        raise ValueError("An explicit device serial is required")
    # Check that the local reference still agrees with its manifest before
    # contacting the device. This read is outside the timed transfer.
    verify_copy(manifest, workload, workspace / manifest["fixture"] / workload)
    output.mkdir()
    payload = output / "payload"
    payload.mkdir()
    remote = f"/sdcard/Download/{manifest['fixture']}/{workload}"
    command = [adb, "-s", serial, "pull"]
    command += ["-Z"] if compression == "none" else ["-z", "any"]
    command += [remote, str(payload.resolve())]
    start = time.perf_counter()
    # Inherit progress/errors: no unbounded captured output or shell quoting.
    # subprocess.run kills and waits for its client on timeout/interrupt.
    subprocess.run(command, check=True, timeout=600, stdin=subprocess.DEVNULL)
    seconds = time.perf_counter() - start
    report = result(manifest, workload, payload / workload, seconds, "adb", compression)
    write_json(output / "result.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("prepare", help="Create new local random fixtures; no ADB")
    make.add_argument("workspace", type=Path)
    make.add_argument("--large-mib", type=int, default=64)
    make.add_argument("--small-count", type=int, default=1000)
    download = commands.add_parser("pull", help="Download one staged fixture using ADB")
    download.add_argument("workspace", type=Path)
    download.add_argument("--serial", required=True)
    download.add_argument("--workload", choices=WORKLOADS, required=True)
    download.add_argument("--output", type=Path, required=True, help="New directory; parent must exist")
    download.add_argument("--compression", choices=("none", "any"), default="none")
    download.add_argument("--adb", default="adb", help="ADB executable path")
    check = commands.add_parser("verify", help="Verify a manually copied workload; no ADB")
    check.add_argument("workspace", type=Path)
    check.add_argument("--workload", choices=WORKLOADS, required=True)
    check.add_argument("--copy", type=Path, required=True, help="Copied large/ or small/ directory")
    check.add_argument("--seconds", type=float, required=True, help="Manually measured copy duration")
    check.add_argument("--backend", choices=("mtp", "local-control"), required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            report = prepare(args.workspace, args.large_mib, args.small_count)
            report = {"fixture": report["fixture"], "files": len(report["files"]),
                      "bytes": sum(entry["bytes"] for entry in report["files"].values())}
        elif args.command == "pull":
            report = pull(args.workspace, args.serial, args.workload, args.output,
                          args.compression, args.adb)
        else:
            report = result(load_manifest(args.workspace), args.workload, args.copy,
                            args.seconds, args.backend, "not-controlled")
        print(json.dumps(report, indent=2, allow_nan=False))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Benchmark failed: {error}\nNo verified result was recorded.\n")
    except KeyboardInterrupt:
        parser.exit(130, "Benchmark cancelled. No verified result was recorded.\n")


if __name__ == "__main__":
    main()
