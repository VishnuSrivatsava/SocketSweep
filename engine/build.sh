#!/usr/bin/env bash
# ============================================================================
# build.sh — Cross-compile daemon.cpp for Android aarch64
# ============================================================================
set -euo pipefail

if [ -z "${NDK:-}" ]; then
    for candidate in \
        "$HOME/Android/Sdk/ndk/"* \
        "$HOME/Library/Android/sdk/ndk/"*; do
        if [ -d "$candidate/toolchains/llvm/prebuilt" ]; then
            NDK="$candidate"
            break
        fi
    done
fi

if [ -z "${NDK:-}" ]; then
    echo "ERROR: Android NDK not found. Set the NDK environment variable."
    exit 1
fi

echo "[build] Using NDK: $NDK"

case "$(uname -s)" in
    Linux*)  HOST_TAG="linux-x86_64"   ;;
    Darwin*) HOST_TAG="darwin-x86_64"  ;;
    *)       echo "Unsupported host OS"; exit 1 ;;
esac

TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"
CC="$TOOLCHAIN/bin/aarch64-linux-android31-clang++"

if [ ! -x "$CC" ]; then
    echo "ERROR: Compiler not found at $CC"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/daemon.cpp"
OUT="$SCRIPT_DIR/daemon"

echo "[build] Compiling daemon.cpp → daemon (aarch64-linux-android) ..."

"$CC" \
    -std=c++17 -O2 -Wall -Wextra -Wpedantic \
    -fno-exceptions -fno-rtti -DNDEBUG \
    -static-libstdc++ \
    -o "$OUT" "$SRC"

echo "[build] Output: $OUT  ($(wc -c < "$OUT" | tr -d ' ') bytes)"
echo "[build] Done."
