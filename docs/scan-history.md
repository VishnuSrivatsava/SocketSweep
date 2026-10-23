# Successful-scan history

The results header compares current totals with the previous comparable recorded
scan: no previous comparable scan, unchanged totals, or signed changes in bytes,
files and folders. Queries use the existing host catalog, with no new ADB calls
or device traversal. Deletion permissions are unchanged.

Only verified, published scan completions with **zero access errors** become
history baselines. Failed, cancelled, truncated, root-changed and partially
readable scans leave previous history intact. History failures never turn a
successful scan into a failed scan; the comparison becomes unavailable and the
reason is written to stderr. A complete scan with legitimate exclusions can be
recorded, but different exclusion/duplicate counts do not compare.

## Stored data and comparison boundaries

`scan-history.json` lives in Tauri's app data directory:

- macOS: `~/Library/Application Support/com.mathcuber.socketsweep`
- Linux: `$XDG_DATA_HOME/com.mathcuber.socketsweep`, normally
  `~/.local/share/com.mathcuber.socketsweep`
- Windows: `%APPDATA%\com.mathcuber.socketsweep`

The file contains **device serials and scan-root paths**, access mode, exclusion
policy, counting-semantics version, skipped-entry counts, totals and Unix
recording times. It stores no descendant filenames, per-file inventory, file
contents or authentication secrets. Files created on Unix have mode 0600;
Windows uses the app data directory's inherited permissions. This is local
plaintext metadata, not encrypted storage.

Comparisons require matching device serial, daemon-confirmed root, access mode,
exclusion policy, counting-semantics version and skipped-entry count. Root mode
reports its resolved root; shell mode retains the confirmed requested root.
Different shell aliases remain separate keys rather than being guessed
identical on the host. A counting/exclusion rule change must bump the semantics
version. Version 1 is the first history format; unsupported format versions are
left unchanged, with no speculative migration.

Deltas describe logical scanned bytes and counts, not file-content changes,
physical free-space changes or Android app ownership. Equal exclusion counts
are a conservative comparison gate, not proof that every excluded entry is
identical. External changes require a rescan. Deleted catalog entries change the
live comparison immediately, but only another successful scan records a new
baseline. Previously recorded totals are not edited after an in-app deletion.

## Storage and failure behavior

A persistent `scan-history.lock` uses Rust's native, nonblocking OS file lock
across the complete read/modify/replace operation. Another writer skips history
recording for that scan instead of waiting or losing an update. Closing or
crashing the process releases the OS lock; the lock file itself stays present
and must not be deleted while any app instance is running. Rust **1.89+** is
required for the standard-library locking API. Unix opening flags use the
already-transitive `libc` dependency directly; no locking library is added.

History reads reject symlinks and special files and read at most 256 KiB
plus one byte. Oversized or unreadable files are left untouched. Within the
budget, the format version is checked before decoding entries. Malformed
current-format content is renamed to `scan-history.invalid-<timestamp>.json`
and retained for inspection. Unknown versions are never quarantined or
rewritten merely because their entry schema differs.

Retention keeps at most ten entries per device/root/mode/policy key, at most
100 overall, and at most 256 KiB serialized, dropping oldest entries first.
Each replacement uses an exclusively created temporary file in the same
directory, flushes its data, closes it and atomically renames it over the old
file. A write or rename failure leaves the previous valid file intact. Unix
also syncs the containing directory after publication; if that fails, the
update has already been published and the error says so. Windows has no
portable standard-library directory-sync equivalent. Universal power-loss
durability across filesystems and hardware is not claimed.

Unpublished temporaries are never used as baselines. A writer cleans them only
after acquiring the cross-process lock, so it cannot delete another cooperating
writer's active temporary. Its own failed writes clean up their temporary.
Quarantined files remain until manually removed. To reset history, close all
app instances and remove `scan-history.json`; the next eligible scan starts a
new history.

## Validation

Host tests cover key separation, coverage eligibility, malformed and future
schemas, bounded reads/retention, interrupted temporary writes, permission and
non-regular-path failures, Unix symlinks/private file modes, and a separate
process holding the OS lock. Rust serialization and frontend parsing share a
first-scan wire fixture, preventing null-versus-omitted fields from drifting.
Scoped queries reject old generations/revisions and compare live catalog
totals. Existing stream tests cover invalid/truncated completion and cancellation
before publication; the history hook runs strictly after that publication gate.

Node tests validate numbers, timestamps, scopes and reconciliation. The built
UI replay uses mocked IPC for first comparisons, unchanged rescans, deletion
deltas, device separation and partial-scan unavailability. These are offline
checks, not physical-device validation. To check manually, restart
`npm run tauri dev`, scan twice, then use a disposable deletion and rescan.
No Android daemon rebuild is required.

Tracked in #36, adapting the history idea from
[Shanmukh's fork](https://github.com/ksaishanmukh/SocketSweep/tree/d677b530e00dec75c305fc56318720aa8c161692)
(commits `d8918df`, `5e442e2`) to verified completions and the current host store.
