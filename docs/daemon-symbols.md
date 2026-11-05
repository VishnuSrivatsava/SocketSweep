# Daemon crash symbols

CI builds optimized Android daemons for all four ABIs with debug information, archives the
unstripped executable, and strips a separate copy for Tauri to bundle. Debug
files stay outside `src-tauri/bin`; they are not pushed to the phone by the app.
This addresses [#15](https://github.com/VishnuSrivatsava/SocketSweep/issues/15).

Each macOS/Linux/Windows job uploads a separate workflow artifact:

```text
daemon-symbols-<platform>-android-<full-workflow-commit-SHA>-attempt-<N>
  socketsweep_daemon
  metadata.json
  armeabi-v7a/
    socketsweep_daemon
    metadata.json
  x86/
    socketsweep_daemon
    metadata.json
  x86_64/
    socketsweep_daemon
    metadata.json
```

`socketsweep_daemon` is the unstripped archive filename. Owned sessions execute
a private copy named `daemon`; the explicit `--obj` lookup below works with
either on-device name. `metadata.json` records the workflow commit, host platform, Android
target, workflow run/attempt, shared ELF build ID, SHA-256 and size of both executables, and a real
symbol-lookup smoke check. Host jobs may use different NDK versions; their
symbols are not interchangeable just because their source commit matches.
For pull requests, the workflow commit can be GitHub's test merge commit rather
than the branch head. Use the actual run and manifest.
Reruns keep separate attempt artifacts rather than overwriting earlier symbols.

Artifacts are uploaded immediately after compilation and verification, before
desktop packaging. They are retained for 90 days, subject to repository policy
and run/artifact deletion. They are not attached to releases by this change.
Download and archive the matching artifact before it expires if long-term
support is required. Old binaries cannot acquire matching symbols retroactively
by rebuilding their source with another compiler.

## Match before symbolizing

1. Find the workflow run that produced the installed desktop build and download
   its platform's `daemon-symbols-...` artifact.
2. Match the tombstone's daemon `BuildId` to `metadata.json`'s `build_id`. When
   the exact bundled/collected stripped daemon is available, also compare its
   SHA-256 with `stripped_sha256` and inspect its build ID with the NDK tool:

   ```sh
   /path/to/ndk/toolchains/llvm/prebuilt/<host>/bin/llvm-readelf --notes /path/to/daemon
   ```

3. Use the module-relative hexadecimal `pc` from the daemon's tombstone frame:

   ```sh
   /path/to/ndk/toolchains/llvm/prebuilt/<host>/bin/llvm-symbolizer --obj=/path/to/socketsweep_daemon 0xFRAME_PC
   ```

Replace `FRAME_PC` with the hexadecimal value, not the frame number, an absolute
ASLR address, or a literal placeholder. Windows tools have `.exe` suffixes;
quote paths containing spaces. Repeat for relevant daemon frames. Symbols for
the daemon do not resolve addresses belonging to separate system libraries.

[LLVM documents address-to-source lookup](https://llvm.org/docs/CommandGuide/llvm-symbolizer.html).
Optimized/inlined code can map several frames to one source location or omit
some variables; debug data does not turn an optimized release into a debug build.
If the build ID does not match, report that symbols are unavailable rather than
interpreting output from a different build. Review tombstones for private paths
or other device details before sharing them publicly.

## What CI verifies

`tests/check_daemon_symbols.py` uses the NDK's LLVM tools to require the selected ABI's ELF class and machine,
identical nonempty build IDs, debug/line/static symbol sections in the
archive, and their absence in the bundled binary. It compares the `.text` bytes
and virtual addresses before/after stripping, then resolves the actual `main`
address to `engine/daemon.cpp` with a nonzero source line. Only after those checks
does it write the artifact manifest. A missing tool or failed check fails CI.

These are host-side ELF checks: they neither run the Android daemon nor require
a crash, ADB, a connected phone, or the desktop app. Local `engine/build.sh` builds all four stripped binaries by default.
Pass `--abi <name>` to rebuild one ABI.


The build entry point also accepts `--abi armeabi-v7a`, `--abi x86`, or
`--abi x86_64` with `--platform` and `--commit`. These builds
write `src-tauri/bin/daemon-<abi>`, with debug files under `daemon-symbols/<abi>/`.
The checker validates the requested ELF class and machine as well as matching
build IDs, code bytes, and source lookup. Verification finishes before publishing
the stripped binary. CI cross-builds and verifies all four ABIs. Desktop installers bundle all four stripped binaries. The selected device’s ABI list determines which binary is pushed.

Linux packages store the Android ELF resources in
`/usr/share/SocketSweep/bin/`. This keeps AppImage dependency discovery from
treating x86 Android binaries as host Linux shared libraries. The native ADB
resource stays under `/usr/lib/SocketSweep/bin/`. Linux debug builds resolve
the daemon files directly from the development checkout.
