# Search from a completed scan

Choose **Search** in the results to look for entry names anywhere in the
current scan. The query runs against the existing host catalog: it does not
rescan the phone, read file contents, or issue ADB commands. Switching from a
zoomed storage map searches the whole scan, not the visible directory.

## Matching rules

- The query matches as a **substring of the entry's exact stored name**.
  ASCII letters compare case-insensitively (`PHOTO.JPG` matches `photo.jpg`);
  every other byte, including all non-ASCII UTF-8, compares exactly. Matching
  bytes must start on a UTF-8 character boundary, so a multi-byte character
  can never contribute a partial-byte match.
- Names are never trimmed, normalized, or locale-collated. A query with
  leading/trailing spaces only matches names that contain those spaces.
- The stream contract guarantees stored names are valid UTF-8, so displayed
  names are the raw names. Full paths shown under each result are
  reconstructed by Rust from validated names, exactly as browsing shows them.
- An empty query is rejected. A query longer than 255 bytes is rejected:
  the stream decoder rejects entry names over 255 bytes, so nothing can match.

## What is searched

Every live entry of the current scan except the root: counted and uncounted
files, directories, and symlink/special placeholders — the same entries
browsing shows. Deleted subtrees are absent because their keys leave the
catalog's parent indexes. Directory results offer **Show folder** on the
directory itself; file results open the parent.

## Pagination and scope

- Pages hold at most 100 results in the live index's deterministic
  depth-first order (children sorted by size descending, then name, then ID).
  **Previous**/**Next** step whole pages, and `has_more` gates Next; every
  matching entry stays reachable, with no fixed result cutoff.
- Requests are scoped to the current scan generation and revision. Deleting
  anything advances the revision, so an in-progress pagination must be
  restarted from the first page. A stale or malformed reply is rejected by
  the frontend parser and shown through the existing error/retry view.
- Deletion uses the existing node-ID confirmation flow with the same
  eligibility rules as browsing: disabled for read-only scans and for names
  containing line-protocol delimiters.

## Bounds and measurements

The response is bounded by the 1 MiB scan-query limit; 100 rows of 16 KiB
paths cannot exceed it. Each request walks the reachable index once —
O(N + skip) matching time and O(depth + page) auxiliary state — with no
persistent per-query index and no whole-tree copy.

`python3 tests/benchmark_search.py` measures an 86,666-file fixture
(32 directories) built from the production sources on the host — no app,
device, or ADB; warm cache; three runs:

| Query shape | Median response time |
| --- | ---: |
| First page of 894 scattered matches, ASCII-folded query | ~2.2 ms |
| First page of 85,772 common matches | ~0.5 ms |
| Worst-case deep skip (page 858 of 858) | ~1.3 ms |
| No match | ~1.3 ms |

Catalog ingestion of the same fixture took 34–51 ms, and the process peak
RSS including the full catalog was 17.7–19.9 MB. These are host pipeline
measurements, not Android/USB or Tauri IPC benchmarks; time grows linearly
with scan size and skip depth, so a 2,000,000-record scan should still serve
a deep page in tens of milliseconds, but that projection is not measured
here.
