#!/usr/bin/env python3
"""Verify the real Android ELF/symbol pair and record artifact provenance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def check(tools, binary, symbols, commit, platform):
    def run(tool, *args):
        executable = tools / (tool + (".exe" if os.name == "nt" else ""))
        return subprocess.check_output([str(executable), *map(str, args)],
                                       text=True, encoding="utf-8", errors="replace", timeout=30)

    def require(condition, message):
        if not condition:
            raise ValueError(message)

    require(re.fullmatch(r"[0-9a-f]{40}", commit), "Expected a full commit SHA")
    ids = []
    for path in (binary, symbols):
        header = run("llvm-readelf", "--file-header", path)
        require("AArch64" in header and "ELF64" in header, "Expected Android ARM64 ELF")
        match = re.search(r"Build ID: ([0-9a-f]+)", run("llvm-readelf", "--notes", path))
        require(match is not None, f"Missing build ID: {path}")
        ids.append(match.group(1))
    require(ids[0] == ids[1], "Stripped daemon and symbols have different build IDs")
    stripped_sections = run("llvm-readelf", "--sections", binary)
    debug_sections = run("llvm-readelf", "--sections", symbols)
    require(".debug_" not in stripped_sections and ".symtab" not in stripped_sections,
            "Bundled daemon still contains debug/static symbol sections")
    require(all(section in debug_sections for section in (".debug_info", ".debug_line", ".symtab")),
            "Archived daemon is missing debug information")
    # Stripping must preserve code bytes and their virtual addresses.
    require(run("llvm-readelf", "--hex-dump=.text", binary) ==
            run("llvm-readelf", "--hex-dump=.text", symbols), "Stripping changed .text")
    main = re.search(r"^([0-9a-fA-F]+) [Tt] main$",
                     run("llvm-nm", "--defined-only", symbols), re.MULTILINE)
    require(main is not None, "Missing main symbol")
    address = "0x" + main.group(1)
    location = run("llvm-symbolizer", "--no-inlines", f"--obj={symbols}", address)
    require("main" in location.splitlines() and re.search(r"daemon\.cpp:[1-9][0-9]*:", location),
            "Symbol lookup did not resolve main to daemon.cpp")
    metadata = {"commit": commit, "platform": platform, "target": "aarch64-linux-android31",
                "build_id": ids[0], "stripped_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                "symbols_sha256": hashlib.sha256(symbols.read_bytes()).hexdigest(),
                "stripped_bytes": binary.stat().st_size, "symbols_bytes": symbols.stat().st_size,
                "smoke_address": address, "smoke_location": location.strip()}
    (symbols.parent / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metadata, indent=2))
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tools", type=Path, required=True, help="NDK LLVM bin directory")
    parser.add_argument("--binary", type=Path, default=Path("src-tauri/bin/daemon"))
    parser.add_argument("--symbols", type=Path, default=Path("daemon-symbols/socketsweep_daemon"))
    parser.add_argument("--commit", required=True)
    parser.add_argument("--platform", choices=("linux", "macos", "windows"), required=True)
    args = parser.parse_args()
    try:
        check(args.tools, args.binary, args.symbols, args.commit, args.platform)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Daemon symbol verification failed: {error}\n")


if __name__ == "__main__":
    main()
