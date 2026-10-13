# Scan stream v1

`PING` retains authenticated protocol version 3 and advertises
`scan_stream_version: 1`. The desktop bridge requires both. Each connection
still begins with `AUTH <64-hex-character session secret>\n`. The new command
is `SCAN_STREAM <absolute root>\n`; legacy `SCAN` remains available for
reference tests and diagnostics. Keep the client's write side open until the
response finishes: half-close, disconnect, and extra command bytes abort the
stream. Commands cannot contain CR, LF, or NUL, and retain the 16 KiB limit.

Command input is read in bounded 4 KiB chunks. The daemon peeks before consuming
through one newline, leaving surplus bytes in the socket for the next AUTH/command
read or the stream's extra-byte check. Each line has one absolute 30-second
deadline; short reads and interrupted syscalls do not reset it.

## Framing and records

Each frame is a four-byte unsigned big-endian byte length followed by UTF-8
JSON. Length must be between 1 and 131,072 bytes. The envelope has exactly
`type` and `data`; the daemon writes `type` first so the receiver can decode the
selected payload directly. A batch contains 1–128 entries.

```json
{"type":"started","data":{"stream_version":1,"root":"/sdcard","read_only":false}}
{"type":"entries","data":{"entries":[{"id":0,"parent":null,"name":"sdcard","kind":"directory","size":0,"counted":true}]}}
{"type":"entries","data":{"entries":[{"id":1,"parent":0,"name":"photo.jpg","kind":"file","size":7,"counted":true}]}}
```

IDs are contiguous from zero in stream order. A parent must already exist and
be a counted directory. ID zero is the sole root, with the name derived from
the `started` root (`/` names itself). Names remain exact UTF-8 bytes; child
names cannot be empty, `.`, `..`, contain slash/NUL, or exceed 255 bytes. Invalid
UTF-8 causes refusal, never replacement characters in a usable path. Support
for arbitrary filename bytes remains future protocol work.

Kinds are `file`, `directory`, and `other`. File sizes are logical bytes.
Directory and other record sizes are zero: the host derives directory sums.
`counted` distinguishes regular files/directories from zero-byte placeholders
and root-mode deduplicated entries. Uncounted entries cannot have children or
nonzero sizes. A zero-byte regular file still counts as a file. Excluded root
mount aliases are omitted, and the terminal `skipped` counter reports them.

Successful completion is exactly one `done` frame, followed by socket EOF:

```json
{"type":"done","data":{"total_files":1,"total_dirs":1,"total_size":7,"errors":0,"skipped":0,"scan_time_ms":1,"scan_threads":4,"serialize_ms":0,"send_ms":0,"bytes_sent":123}}
```

`bytes_sent` above is illustrative. Its real value must equal the received
bytes of all preceding frames, including length prefixes; the completion
frame itself is excluded. The host checks file/directory/byte totals against
records and subtree sums, rejects duplicate filenames within a directory,
and checks negotiated read-only mode and worker count. Root/read-only scans
retain one worker, mount exclusions and scan-wide inode deduplication.

An error may appear before or during a scan:

```json
{"type":"error","data":{"message":"Scan root changed during scan; scan again"}}
```

Missing/truncated headers or payloads, malformed JSON, unknown fields/types,
invalid ordering, mismatched counts, and any data after completion are errors.
Error counts and exclusions remain visible even for a successfully completed
scan with unreadable areas. Partial/cancelled scans are never successful
baselines. The bridge clears its deletion root before each attempt and only
publishes its scan store after valid completion/EOF and bounded metadata serialization.
The daemon pins its pending root separately and promotes it only after an
unchanged-root check and successful completion write. Existing descriptor-
anchored deletion and root read-only checks remain in force.

## Bounds and cancellation

Normal scanning retains immediate directory jobs rather than completed file
subtrees. The queue holds at most 64 jobs with no descriptors; worker count is
1–8. Inline fallback closes enumeration descriptors first. Shared directory
staging has a conservative 64 MiB budget; exceeding it fails the scan instead
of publishing partial success. Root-mode inode deduplication still requires a
scan-wide set. Output batches flush on count/size limits, after 50 ms of scan
activity, and immediately for the root and first discovered entry.

Socket writes have an absolute 30-second deadline per complete frame, and
host reads an absolute 120-second deadline per complete frame, including its
header. Disconnect/write failure stops further traversal between filesystem
operations. A filesystem operation already blocked in the kernel is not
interruptible by this socket cancellation mechanism.

The host accepts at most 2,000,000 records, depth 64, and path length 16 KiB.
A conservative catalog estimate (path bytes, name bytes, 256 bytes per node)
is capped at 128 MiB; each UI query is capped at 1 MiB. Integer values and
computed totals must fit JavaScript's exact integer range. These are data
budgets, not promises that total process RSS equals those limits.

Progress uses scan IDs, at most five recent names, and a 100 ms update interval
plus first/final updates. Only one message may await acknowledgement from the
webview; subsequent updates coalesce. Late progress/ack/cancel operations
cannot affect a different scan ID. Cancellation bypasses the serialized
operation lock and closes the active socket. The UI discards failed rescan
results and returns to setup, avoiding actions based on an obsolete tree.

The host retains compact verified records and directory indexes in a
[generation-scoped scan store](scan-store.md). The frontend receives metadata,
128-entry directory pages, and a bounded chart instead of the whole tree.
Deletion updates host totals and advances the revision; JavaScript does not
clone or edit a full tree. Scanning still shows partial counts/recent entries,
not a browsable incomplete dashboard. Virtualized rows and the separate SVG
chart work remain #30/#31.

## Timing and attribution

For streamed scans, `scan_time_ms`/`traverse_ms` measure daemon traversal with
interleaved encoding/writes. `serialize_ms` and `send_ms` are cumulative daemon
encoding/write times; `sort_ms` measures host aggregation/sorting and directory index construction. These overlap
and must not be added or compared directly with the old exclusive phase split.
Final host response serialization and frontend rendering are not included.

Directory streaming and compact host construction are inspired by
[Shanmukh's reviewed fork](https://github.com/ksaishanmukh/SocketSweep/tree/d677b530e00dec75c305fc56318720aa8c161692),
particularly `e21a430`, `ec0679f` and `e7a7383`. This implementation keeps the
current C++ engine, authenticated session, anchored reads/deletion and root
safeguards rather than adopting the fork's daemon/transport wholesale.
