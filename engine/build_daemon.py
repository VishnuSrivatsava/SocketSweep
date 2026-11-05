"""Build the Android daemon with an installed Android NDK."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
HOSTS = {
    "linux": "linux-x86_64",
    "darwin": "darwin-x86_64",
    "win32": "windows-x86_64",
}


TARGETS = {
    "arm64-v8a": "aarch64-linux-android",
    "armeabi-v7a": "armv7a-linux-androideabi",
    "x86_64": "x86_64-linux-android",
    "x86": "i686-linux-android",
}


def toolchain(abi):
    host = HOSTS.get(sys.platform)
    if host is None:
        raise ValueError(f"Unsupported build host: {sys.platform}")
    override = next((os.environ[name] for name in (
        "NDK", "ANDROID_NDK_LATEST_HOME", "ANDROID_NDK_HOME"
    ) if os.environ.get(name)), None)
    suffix = ".cmd" if sys.platform == "win32" else ""
    compiler_name = f"{TARGETS[abi]}31-clang++{suffix}"
    if override:
        candidates = [Path(override)]
    else:
        sdk_roots = [
            Path(os.environ[name]) for name in ("ANDROID_HOME", "ANDROID_SDK_ROOT")
            if os.environ.get(name)
        ]
        sdk_roots.extend([
            Path.home() / "Android/Sdk",
            Path.home() / "Library/Android/sdk",
            Path.home() / "AppData/Local/Android/Sdk",
        ])
        candidates = [ndk for sdk in sdk_roots for ndk in sorted((sdk / "ndk").glob("*"))]
    for ndk in candidates:
        compiler = ndk / "toolchains/llvm/prebuilt" / host / "bin" / compiler_name
        if compiler.is_file() and os.access(compiler, os.X_OK):
            return compiler
    if override:
        raise ValueError(f"Compiler not found at {compiler}")
    raise ValueError("Android NDK not found. Set NDK, ANDROID_NDK_LATEST_HOME, or ANDROID_NDK_HOME.")


def build(platform, commit, abi):
    compiler = toolchain(abi)
    local = REPO / "engine/daemon"
    experimental = abi != "arm64-v8a"
    bundle = local.with_name(f"daemon-{abi}") if experimental else REPO / "src-tauri/bin/daemon"
    outputs = (bundle,) if platform or experimental else (bundle, local)
    for output in outputs:
        if output.exists() and not output.is_file():
            raise ValueError(f"Output path is not a regular file: {output}")
    print(f"[build] Compiler: {compiler}", flush=True)
    # Stage beside the destination so compiler or strip failures preserve it.
    with TemporaryDirectory(prefix=".daemon-build-", dir=bundle.parent) as stage:
        staged = Path(stage) / "daemon"
        args = [
            str(compiler), "-std=c++17", "-O2", "-pthread", "-Wall", "-Wextra",
            "-Wpedantic", "-fno-exceptions", "-fno-rtti", "-DNDEBUG",
            "-static-libstdc++",
        ]
        if abi in ("armeabi-v7a", "x86"):
            args.append("-D_FILE_OFFSET_BITS=64")
        if platform:
            symbols_dir = REPO / "daemon-symbols"
            if experimental:
                symbols_dir = symbols_dir / abi
            symbols = symbols_dir / "socketsweep_daemon"
            symbols.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([
                *args, "-g", "-Wl,--build-id=sha1", "-o", str(symbols),
                str(REPO / "engine/daemon.cpp"),
            ], check=True)
            strip = compiler.with_name("llvm-strip.exe" if sys.platform == "win32" else "llvm-strip")
            subprocess.run([str(strip), "--strip-all", "-o", str(staged), str(symbols)], check=True)
        else:
            subprocess.run([*args, "-s", "-o", str(staged), str(REPO / "engine/daemon.cpp")], check=True)
            if not experimental:
                with TemporaryDirectory(prefix=".daemon-build-", dir=local.parent) as local_stage:
                    local_copy = Path(local_stage) / "daemon"
                    shutil.copy2(staged, local_copy)
                    local_copy.replace(local)
        if platform:
            subprocess.run([
                sys.executable, str(REPO / "tests/check_daemon_symbols.py"),
                "--tools", str(compiler.parent), "--platform", platform, "--commit", commit,
                "--abi", abi, "--binary", str(staged), "--symbols", str(symbols),
            ], cwd=REPO, check=True)
        staged.replace(bundle)
    print(f"[build] Updated {bundle}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=("linux", "macos", "windows"))
    parser.add_argument("--commit", help="Commit for the CI symbol manifest")
    parser.add_argument("--abi", choices=TARGETS, default="arm64-v8a")
    args = parser.parse_args()
    if bool(args.platform) != bool(args.commit):
        parser.error("--platform and --commit must be passed together")
    try:
        build(args.platform, args.commit, args.abi)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"ERROR: {error}\n")


if __name__ == "__main__":
    main()
