# Host-owned scan store

A successful stream transfers verified records to Rust. `run_scan` returns
statistics, the root summary, and a fresh public generation rather than a
nested tree. Generations use independent random IDs; the daemon's secret
session token never crosses IPC.

`get_scan_view` accepts a generation, revision, node ID and optional cursor.
It returns the current node, exact path, breadcrumbs, up to 128 children, and
previous/next cursors. Directory indexes sort by size descending, name, then
stable ID. Cursor seeks use `BTreeSet` ranges instead of walking earlier pages.
All entries remain reachable; there is no silent 500-entry cutoff.

The chart contains the largest 64 positive children plus an exact **Other**
remainder. Other has no node ID and cannot zoom or delete. Recharts remains in
use; #31 covers its separate SVG replacement. #30 still covers virtualized
rows and broader navigation work.

## Snapshot and deletion invariants

- Starting a scan, reconnecting or stopping invalidates the current store
  before fallible I/O. Completion publishes only after verified counts,
  terminal EOF, bounded metadata serialization and the cancellation gate.
- Every query, detail request, cursor and delete requires the current generation
  and revision. IDs never renumber within a generation. Deleted nodes and their
  descendants become unavailable; revision changes invalidate older cursors.
- `delete_item` accepts IDs, never a frontend path. Rust reconstructs the exact
  accepted UTF-8 path, refuses the root/read-only entries and line-protocol
  delimiters/oversized commands, then uses the existing authenticated command
  and descriptor-anchored C++ deletion boundary.
- Successful deletion adjusts subtree counts/sizes along the ancestor chain,
  updates directory indexes and advances the revision. JavaScript receives a
  new summary and reloads visible pages; it does not clone a full tree.
- Transport errors, malformed results and partial deletion failures quarantine
  the snapshot. The UI discards results and returns to setup after stopping the
  session. An obsolete result cannot clear a newer generation.
- Connection/scan/delete operations share the existing operation lock. Queries
  take only the store lock, with no network I/O while holding it. Queries see a
  complete revision or fail as stale. Late UI responses cannot replace newer
  requests, and old confirmations cannot survive a rescan.

Stream v1 does not encode arbitrary raw-byte names. Non-UTF-8 data is rejected,
never replaced with a different filename. Accepted names retain their bytes;
full paths are reconstructed transiently, not stored on every UI row. Deleted
subtree records remain allocated until the next scan/disconnect; tombstones
preserve ID safety.

The decoder keeps its existing 2,000,000-entry, depth-64, 16-KiB-path and
128-MiB conservative ingestion bounds. Its estimate includes record/name/index
and staging costs. Each query/summary/deletion response has a 1-MiB serialized
limit; small daemon command replies have a 128-KiB read limit. These are data
budgets, not a total-process RSS guarantee. `sort_ms` includes host aggregation,
sorting and index construction; daemon timing fields retain their meanings.

## Validation

```sh
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
python3 -m unittest discover -s tests -v
python3 tests/check_scan_ui.py
python3 tests/benchmark_scan_store.py
```

The last two commands support macOS/Linux. The UI harness uses installed
Chrome/Chromium (an executable may be passed as its first argument), the actual
built frontend, and mocked IPC. It checks forward/backward paging, nested
paging, delayed zoom, the Other tile, stale confirmation after rescan, ID-only
deletion, revision refresh, partial-error recovery and read-only controls. It
never launches Tauri or contacts ADB. Linux CI runs it after the desktop build;
all three desktop targets run Rust and Node tests.

Rust fixtures compare ordering, paths, parents and totals against the previous
recursive representation, including repeated file/directory deletions,
placeholders, a 64-level path, stale references and concurrent reads. Host daemon
fixtures verify non-UTF-8 bytes on filesystems that support them; unsupported
filesystems skip that case. The decoder also rejects invalid encoding directly.

Native WebView behavior and connected-device interaction remain manual checks.
To try the rebuilt host with the existing daemon:

```sh
npm run tauri dev
```

Check expansion, both page directions in a large directory, zoom/breadcrumbs,
rescan/cancel, reconnect and read-only mode. If testing deletion, create a
throwaway file/directory first and confirm its exact path and updated totals.
The Android engine has not changed and does not need rebuilding for this PR.

## Host fixture measurements

On 2026-10-14, Darwin arm64, Rust 1.95.0 and Node 26.7.0, three release-harness
runs used identical stream-v1 bytes: 86,666 synthetic files in 32 directories
plus their root. Sizes are generated values; these are not phone measurements.
Baseline: `9326b4221adb410c3cbf8562e2777471a4c30083`.

| Metric (median of three runs) | Full-tree baseline | Host store |
| --- | ---: | ---: |
| IPC payload | 8,660,446 bytes | 27,606 bytes |
| Host decode/build/serialize/file-write time | 58.80 ms | 32.36 ms |
| Peak host RSS | 19,169,280 bytes | 17,317,888 bytes |
| Node parse time | 27.21 ms | 0.17 ms |
| Node full-tree clone time | 26.75 ms | No full-tree clone |
| Node heap growth at measurement | 35,155,320 bytes | 248,272 bytes |
| Peak Node RSS | 135,216 KiB | 49,184 KiB |

The store payload includes the summary, root page and one 128-entry directory
page. The baseline sends the whole tree. Node retains the baseline plus its
copy to represent the old deletion path; the new model retains metadata/pages.
RSS includes each runtime, and heap growth is a sampled value, not a GC-adjusted
retained-size or peak-heap claim. These measurements exclude Tauri string
encoding, WebView/React rendering, ADB and daemon traversal. Visiting every
page creates additional bounded requests; the table measures initial browsing.
The benchmark verifies totals, sample directory ordering and exact chart sums.
It does not establish a change in Android scan speed or compare C++ with Rust.

The ownership/query idea is inspired by
[Shanmukh's fork](https://github.com/ksaishanmukh/SocketSweep/tree/d677b530e00dec75c305fc56318720aa8c161692),
particularly `e7a7383`, `b0087a9` and `b03ae60`. The C++ daemon, authenticated
transport and existing secure deletion boundary remain in place.
