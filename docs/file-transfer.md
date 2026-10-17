# File-transfer baseline and single-file export plan

Tracked in [#59](https://github.com/VishnuSrivatsava/SocketSweep/issues/59).
This change adds an experiment and a design, not an application download button.
No device throughput has been measured for this work. Backend selection remains
open until the manual results and source-access requirements below are assessed.

## Why measure the existing backend first?

[ADB already supports file and directory downloads, explicit device selection,
and optional compression](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md).
Using it may avoid maintaining another binary protocol in both the C++ daemon
and Rust host. It does not provide the application's overwrite, session,
cancellation, or source-confinement policy by itself.

[matu6968's transfer fork](https://github.com/matu6968/SocketSweep/commit/eda8a628cdd14d0a66f24fb86a093fc0cf5971dc)
provides useful prior art for file pickers, progress, and streaming transfers.
Its direct destination writes are unsuitable for adoption unchanged: a failed
transfer can damage an existing destination. It also predates the current
authenticated sessions and generation-scoped scan store. No transfer-speed
advantage has been demonstrated here. Scan traversal timings do not establish
file-copy throughput.

## Run the disposable experiment

Requirements: Python 3.9+, an installed ADB CLI supporting `pull -Z`, a connected
authorized device, and enough free host/device space. The script uses only the
Python standard library. **Only the `pull` subcommand contacts a device.**
Upload and cleanup are manual. There is no remote shell, deletion, daemon start,
root command, or permission change in the script.

Run these commands yourself from the repository root. On macOS/Linux:

```sh
BENCH_BASE=$(mktemp -d /tmp/socketsweep-transfer.XXXXXX)
WORKSPACE="$BENCH_BASE/fixture"
python3 tests/benchmark_transfer.py prepare "$WORKSPACE"
FIXTURE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["fixture"])' "$WORKSPACE/manifest.json")

# Choose the exact serial from your own device list.
adb devices -l
SERIAL='YOUR_DEVICE_SERIAL'
adb version

# /sdcard/Download must already exist. Upload only the generated fixture.
adb -s "$SERIAL" push -Z "$WORKSPACE/$FIXTURE" /sdcard/Download/

# First verified ADB downloads; each output directory must be new.
python3 tests/benchmark_transfer.py pull "$WORKSPACE" --serial "$SERIAL" --workload large --output "$BENCH_BASE/adb-large-1"
python3 tests/benchmark_transfer.py pull "$WORKSPACE" --serial "$SERIAL" --workload small --output "$BENCH_BASE/adb-small-1"
```

The default fixture is one 64 MiB file and 1,000 files of 4,096 bytes each
(67.90625 MiB total). Bytes come from `os.urandom`; they approximate incompressible
data, not zero-filled files that make compression look unrealistically fast.
The same fixture must be used across backends. A new fixture has a random UUID
name and a SHA-256 manifest. Creation never reuses an existing workspace.
`prepare --large-mib 512 --small-count 2000` can create a longer experiment in a
new workspace; limits are 1–1,024 MiB and 1–5,000 small files. Generation, upload,
and hash checking are not part of measured transfer time.

An ADB run writes `result.json` only after a successful command and exact file
count, type, size, and SHA-256 verification. It reports transfer wall time,
verification time separately, and payload MiB/s. Serial numbers are not written
to the result. Console ADB output may still contain device/local information;
review it before posting. `--compression any` explicitly tests ADB's negotiated
compression separately; default `none` passes `-Z`. No silent flag fallback is
allowed. `--adb /path/to/adb` selects another executable if needed.

For MTP, use your chosen MTP client to copy the **large** workload directory from
`Download/<fixture>/large` into a fresh local directory. Time the copy from start
until the client reports completion; stop the timer before hash verification.
Then run, substituting your destination and measured seconds:

```sh
python3 tests/benchmark_transfer.py verify "$WORKSPACE" --workload large --copy /path/to/copied/large --seconds 12.34 --backend mtp
```

Repeat for `small`. `verify` prints JSON only on success and never contacts the
device. MTP timing is explicitly manual; it is not directly instrumented like
ADB timing. Use `--backend local-control` only for an offline copy/harness check,
never as a device performance result. Copy directories must contain exactly the
generated regular files; missing/extra entries, symlinks, directories, changed
sizes, or changed hashes fail validation.

Use at least three verified runs per workload/backend, with a new destination
each time. Alternate ADB and MTP order between rounds. Keep first and repeated
runs separate; upload and previous reads warm caches. Do not claim cold-cache
measurements without a controlled way to establish them. Keep the same cable,
port, device mode, and workload. Some MTP clients may require releasing their
connection before ADB can use USB; record that and exclude switching/setup from
the timed copy consistently. Do not change global ADB server state to make a
benchmark pass.

Record device model/Android version (not serial), host OS, ADB version, MTP
client/version, cable/port, workload manifest, compression setting, run order,
all verified durations, and failures. Report medians **and individual runs**.
64 MiB may be too short for sustained throughput: increase it if startup cost or
timing precision dominates. These two workloads do not cover real photos,
compressible data, arbitrary filenames, or long-duration thermals.

On failure, timeout (10 minutes per ADB copy), or Ctrl-C, the fresh output folder
may contain partial data; no successful result is written. Keep it for inspection
or remove that exact local experiment folder manually. Do not reuse it. After
testing, delete only the UUID-named fixture directory you created in the phone's
Download folder through your file manager, and your local experiment directory.
No automatic recursive device cleanup is supplied.

The tool assumes a trusted local experiment directory. It rejects manifest path
traversal and copied symlinks but does not defend against another process racing
local filesystem operations. It is not a safe-export implementation to copy into
the application.

## Safe first application export

Scope: save one regular file from the current scan to the computer. No folders,
uploads, custom protocol, APK, or Android OS changes in this step.

| Boundary | Required behavior |
| --- | --- |
| Frontend → Rust | Accept the current generation, revision, and node ID; resolve the exact path and regular-file kind in the Rust catalog. Never accept a frontend-supplied device path or destination path. Preserve Unicode, whitespace, and punctuation exactly. |
| Session ownership | Bind an operation to the device serial and session identity before opening the native save picker; recheck after the picker and before publishing. Reconnect, rescan, deletion, disconnect, or cancellation invalidates stale work. Coordinate with session teardown without holding a lock that prevents cancellation. |
| Privilege | Start with ordinary shell-readable shared storage. Never invoke `adb root`, `su`, or change permissions to make a download work. Root-only paths remain unsupported until their read-access policy is explicitly designed. |
| Destination authority | Rust owns the native save picker result and collision decision. A filename from the device is only a suggested basename, never a local relative path. An unconfirmed collision cannot truncate or replace an existing file. |
| Staging and commit | Download into a private, exclusively created staging location on the destination filesystem. Verify completion and close handles before publishing. The final commit must enforce the confirmed collision policy under races, including a destination appearing after the picker. Preserve existing destination bytes on every pre-commit failure; clean up only this operation's staging files. Define and test platform-specific commit semantics rather than assuming ordinary rename means no-clobber. |
| Source identity | A scanned path is a snapshot, not a durable handle. Decide whether a changed file is rejected; do not claim source confinement or snapshot identity from a preflight `stat` followed by `adb pull`. Symlink replacement and source mutation require explicit handling. |
| Progress and cancellation | Bound progress event frequency and payload. Bind every event/cancel request to an operation ID. Kill and reap only its child process, close handles, and remove its staging files. Timeout, unplug, user cancel, and stale-session errors cannot publish success. Define the commit point: cancellation before it aborts; after commit report that the file was saved. |
| Integrity and errors | Check subprocess/protocol completion, actual bytes written, and the agreed source-change policy before commit. Do not label a size check as a hash check or promise original creation-time preservation. Surface actionable failure reasons without exposing session tokens. |

The current scan catalog's scoped IDs are a useful foundation, but they do not
yet provide an export operation. Session lifecycle changes should fit the work
tracked in [#37](https://github.com/VishnuSrivatsava/SocketSweep/issues/37).

### Backend decision and acceptance

Prefer ADB if measured performance is adequate **and** its behavior can satisfy
the agreed access/identity contract. A speed win cannot justify bypassing source
policy. If securely opening a file beneath an approved root cannot be guaranteed
through ADB, evaluate a narrowly scoped authenticated daemon read using an
anchored file descriptor and no-follow traversal, not the fork's prefix checks.
That is a separate implementation decision after this baseline.

Before shipping, test the actual chosen backend with fake-process/host fixtures
for existing-target preservation, collision races, cancellation before and after
commit, timeout/unplug, stale generation/session, source change, symlinks,
zero-byte files, exact unusual names, and Windows/macOS/Linux destination rules.
Then manually validate picker, progress, cancel, and byte integrity on a connected
device. Neither the benchmark's mocked ADB tests nor a production build proves
those application behaviors. Record the device evidence in #59 and open a focused
implementation issue after choosing the backend and resolving these contracts.
