# Android scan worker benchmark

Ordinary scans already use four C++ workers. Compare worker counts on the same
phone before changing that default or replacing traversal. This developer tool
does not change the app's behavior and makes no speedup claim.

## Run manually

Use the development prerequisites in the README, including a current ARM64
Android daemon at `src-tauri/bin/daemon` and the bundled host ADB. Stop any active
app scan, connect and authorize the phone, and run from the repository root:

```sh
python3 tests/benchmark_device_scan.py --serial YOUR_DEVICE_SERIAL
```

On Windows, use `python`. An explicit serial is mandatory; another device is
never selected as a fallback. The default root is `/sdcard`. To use a quieter
existing directory, append `--root /sdcard/Download`. `--adb` and `--daemon`
accept explicit executable/artifact paths. `--output` selects a new directory
whose parent must exist; existing directories are refused.

Keep the phone awake, temperature and power conditions stable, and storage
unchanged. Pause downloads, camera use and other writers. The experiment takes
several minutes for a large tree. Its first run also compiles an optimized Rust
test executable; it does not open the app. Root/read-only sessions are refused
because that traversal is serial. The tool does not root/unroot the phone,
restart ADB, drop caches or modify scanned files.

## What the experiment verifies

The wrapper snapshots the local daemon and records its SHA-256. Four independent
owned sessions use those same bytes, one each for 1, 2, 4 and 8 workers. They scan
sequentially; the other daemons are idle. One warm-up per mode precedes five
measured rounds with mixed order:

```text
1 4 2 8
8 2 4 1
2 1 8 4
4 8 1 2
1 8 2 4
```

All 24 scans pass through the application's authenticated stream decoder,
including completion totals, byte counts and terminal EOF checks. Each scan
must report the requested worker count. Exact paths, entry types, sizes,
counted flags, totals, errors and skipped counts must match the first warm-up.
Arrival order and internal node IDs may differ. A changed tree invalidates the
experiment; choose a quiet folder and retry. Matching nonzero errors/skipped
counts describe matching partial coverage, not complete access to the device.
This is metadata equality, not a file-content hash comparison.

The report contains individual runs and medians of the five measured runs:

- `scan_ms`: daemon-reported scan time, including its existing streaming timing
  semantics. Serialize/send phases overlap traversal and must not be added.
- `stream_wall_ms`: host time from TCP connection through authenticated command,
  strict decoding and terminal EOF. It excludes daemon/session startup, the GUI,
  and the app's catalog/index construction.
- `snapshot_ms`: host metadata canonicalization after the timed stream. This
  comparison work does not count toward `stream_wall_ms`.

This is a warmed, current-binary scaling experiment. It cannot establish cold
cache performance, explain old versus new build regressions, or reproduce the
full GUI scan duration. Compare both scan and stream medians, review variation
across individual runs, and repeat before making a worker-default change.

## Results and cleanup

The tool prints its result directory and a median table. Share `result.json`
after reviewing it. It includes the selected root, device model, Android SDK,
host OS/architecture, ADB version and daemon hash. It excludes the device serial,
authentication tokens and enumerated filenames. Exact trees exist only in host
memory during comparison. `trials.jsonl` is an incremental journal;
`measurements.json` is an intermediate report. Neither substitutes for the final
verified `result.json`, which is created only after successful cleanup.

Press Ctrl+C once to cancel and wait for cleanup. The wrapper closes a private
pipe; Rust interrupts its active scan socket and uses normal owned-session
cleanup. Failure also attempts cleanup for every started session. No process
name kill, shared-path deletion or foreign-forward removal is used. If the
phone disconnects, ADB fails or the cleanup deadline expires, private session
resources may remain and the tool reports failure. A forced second interruption
can also prevent cleanup. Do not interpret partial output as a valid comparison.

## Offline validation

```sh
python3 -m unittest discover -s tests -p 'test_*benchmark.py' -v
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
```

Normal tests and CI never contact a phone. Python tests mock Cargo. Rust tests
exercise comparison/cancellation and, on non-root Unix hosts, fake ADB with a
real host-built daemon, checking successful and failed experiment cleanup.
The live experiment is an ignored Rust test requiring explicit environment
opt-in; invoke it through the wrapper, not by running all ignored tests.
