# Diagnostic log retention

The log shows the newest entries from the current app session, including across
rescans and reconnects. It is not persisted or a complete session archive.
`src/logHistory.ts` enforces these fixed limits at the log append boundary:

- At most 500 retained entries and rendered log rows.
- At most 131,072 UTF-16 code units of retained text (256 KiB at two bytes per unit).
- At most 4,096 UTF-16 code units per entry, including `… [truncated]` when needed.

Oldest entries are evicted until both count and text limits hold. Timestamps and
chronological order are preserved. A notice outside the scrolling list reports
how many older entries were discarded. Long-message truncation preserves the
beginning and avoids cutting a surrogate pair. Only diagnostic display text is
limited; scan data, exact paths, confirmation details and command arguments do
not pass through this formatter.

Bounded text is materialized with a JSON string round-trip so a slice/rope does
not keep a large source string alive. History updates are immutable, and retained
row keys follow their original sequence positions when oldest entries are evicted.
The text budget does not claim a hard JavaScript heap, DOM or process-memory limit;
object overhead, transient inputs and React state/render snapshots also consume memory.

## Verification and measurements

`npm test` checks chronological retention, both limits, multi-entry eviction,
Unicode/control text, immutable updates, diagnostic truncation and 10,000 mixed
messages with exact discard accounting. `npm run build` checks TypeScript and the
production bundle. After building, `python3 tests/check_scan_ui.py` exercises the
built app with oversized mocked ADB diagnostics, retains the existing safe deletion
and session checks, and tests the actual log model/component using synthetic replays.
The isolated browser fixtures are compiled only into a temporary test site.

Host append/retention comparison:

```sh
node tests/benchmark_log_history.mjs
```

On 2026-10-14, macOS arm64 / Node 26.7.0, three isolated runs per version with
20,000 synthetic path messages produced these medians:

| Measurement | Former unbounded append | Bounded append |
| --- | ---: | ---: |
| Append loop | 311.970 ms | 28.193 ms |
| Retained entries | 20,000 | 500 |
| Retained text, two bytes per UTF-16 unit | 6,217,780 bytes | 156,000 bytes |
| Sampled heap growth after explicit GC | 5,182,280 bytes | 167,368 bytes |

The former loop uses the previous `[...entries, message]` operation. Both receive
the same generated messages; timestamp formatting is outside the measured loop.
Heap deltas depend on V8 and GC and do not describe total application memory.

A single local headless Chromium replay at 1280×861 CSS pixels / 1× measured
1,279.9 ms to mount/layout 20,000 rows versus 39.4 ms for 500 rows. This uses the
same current log component with unbounded and bounded histories, separated by
unmount; it is not a complete old/new-app benchmark. Timings include commit polling,
layout and two animation frames, are hardware-dependent, and are not CI thresholds.
A long-message replay retained 33 rows and 254,212 bytes after adding fresh error/
shutdown diagnostics; its discard notice remained visible while scrolling.

These are synthetic Node/Chromium checks, not native WebView, phone or scan-speed
measurements. Native verification uses `npm run tauri dev`; no daemon rebuild is
needed. Generate repeated operations and confirm newest diagnostics remain visible
with clear notices whenever older or oversized text is omitted.
