# Largest files from a completed scan

Choose **Largest files** in the results to see the top 10, 25 (default), 50 or
100 counted regular files across all scanned directories. Sizes and paths come
from that scan, not a fresh device traversal. The global storage totals remain
unchanged when switching views. Zero-byte counted files are included; excluded
entries, special files and uncounted duplicate hard links are not ranked.

**Show folder** opens the file's parent in the storage map. **Delete** uses the
existing exact-path confirmation and generation/revision-scoped node ID flow.
Root scans remain read-only. Names containing line-protocol delimiters remain
visible with exact paths but cannot be deleted through the app. Device changes
outside SocketSweep require a rescan; a failed or partial deletion invalidates
the local snapshot through the existing deletion handling.

## Ownership and bounds

`Catalog::largest_json` traverses only reachable catalog children. Removing a
directory makes its entire subtree unreachable, even though descendant records
remain in the underlying scan allocation. A standard-library `BinaryHeap` holds
at most K ranking keys; no whole-tree clone, sort or second persistent index is
needed. Results sort by descending size, then exact file name and scan node ID,
matching directory ordering. IDs break ties between equal names in different
folders. Names are not normalized.

The backend rejects limits outside 1–100 and stale scan generations/revisions.
Ranking takes O(N log K) time and O(K + depth) auxiliary ranking/traversal memory.
The decoder already bounds depth and individual paths. Only selected paths and
node summaries are serialized. The existing 1 MiB response cap still applies:
if many long paths exceed it, the query fails and asks for a smaller limit.
The limit selector remains available after an error. Frontend queries hide old
rows immediately when their scan revision or limit changes and ignore late
responses after replacement or unmount.

The frontend also validates the response before rendering rows or actions:
matching scope/workload/limit, exactly the bounded number of rows, unique
unsigned IDs and paths, counted regular-file metadata, safe sizes, descending
size order, exact root/name/path relationships and deletion eligibility.
Selected bytes cannot exceed scan totals; a complete list must reconcile with
the scan's bytes. Valid UTF-8 labels, including whitespace, BOM and CR/LF names,
remain exact. Delimiter-containing or oversized command paths cannot offer
deletion. Invalid data uses the existing error/retry view instead of crashing
the results screen. Rust remains the final authority for IDs, paths and deletes.


This is an adaptation of the largest-files idea in Shanmukh's fork at
[`d677b530`](https://github.com/ksaishanmukh/SocketSweep/tree/d677b530e00dec75c305fc56318720aa8c161692)
(commits `670736d`, `5e442e2`), implemented on SocketSweep's existing host catalog.
No device daemon changes, dependencies or new ADB operations are needed.

## Validation

Rust tests compare every supported K against an exhaustive reference sort on
1,040 counted files, including nested files and size/name/ID ties. Additional
fixtures cover empty scans, zero-byte files, exact Unicode/whitespace/CR/LF
paths, root read-only flags, invalid limits/scopes, deep-path response limits,
removed subtrees and snapshot invalidation when a file is missing at deletion.

The built frontend replay uses mocked IPC in headless Chrome. It covers limit
changes with delayed old responses, query errors/retry, exact displayed paths,
ID-only deletion and revision refresh in both views, read-only deletion controls,
folder navigation and no additional scan commands. Existing paging, confirmation,
shutdown, device selection, toast and diagnostic checks remain in the replay.

Run the host-only release benchmark with:

```sh
python3 tests/benchmark_largest_files.py
```

On an Apple M2 (arm64 macOS), a synthetic scan of **250,000 files across 32 folders** produced an
**18,510-byte** top-100 response. Across three processes, each with 31 queries,
process medians were **4.81–4.91 ms**, and p95 values were **6.65–7.28 ms**.
Process peak RSS was **48.37–48.40 MB** for loading the catalog alone and
**48.78–48.82 MB** for loading plus repeated queries (decimal MB). These RSS
measurements include decoder/catalog construction and allocator noise; they do
not isolate query allocations or demonstrate a memory reduction. The hard
100-key selection bound follows from the production heap algorithm.

No native app or physical device was used for these automated checks. To check
on a connected device yourself, run `npm run tauri dev`, scan normally, switch
views and limits, use Show folder, then confirm a deletion only on a disposable
file. Repeat with a root read-only scan if supported by your phone.
