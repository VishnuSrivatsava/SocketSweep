# File types from a completed scan

Choose **File types** in the results to see file counts, bytes and percentage of
scanned file bytes across the entire scan root. Switching from a zoomed storage
map still summarizes the whole scan. The view queries the existing host catalog;
it does not rescan the phone, read file contents or issue ADB commands.

Classification uses the final filename suffix, compared case-insensitively for
ASCII letters. Names are not trimmed or normalized. A name without a suffix,
a single leading-dot name such as `.nomedia`, or a trailing-dot name such as
`backup.` belongs to **No extension**. `.config.JPG` belongs to Images;
`backup.tar.gz` belongs to Archives; `photo.jpg.exe` and `photo.jpg ` belong to
Other extensions. This is a filename heuristic, not content or MIME detection.

| Category | Recognized extensions |
| --- | --- |
| Images | jpg jpeg png gif webp heic heif avif bmp tif tiff svg ico dng |
| Videos | mp4 m4v mkv webm avi mov 3gp 3g2 mpeg mpg wmv flv |
| Audio | mp3 m4a aac flac ogg opus wav wma amr mid midi aiff ape oga |
| Documents | pdf txt md rtf doc docx odt xls xlsx ods csv ppt pptx odp epub mobi |
| Archives | zip 7z rar tar gz bz2 xz zst tgz tbz tbz2 txz |
| Android packages | apk apks xapk aab |
| No extension | No nonempty suffix with a nonempty stem |
| Other extensions | All remaining suffixes, including ambiguous `ts` |

Only live, counted regular files contribute, using the same bytes and counting
rules as the scan. Zero-byte files contribute to file counts. Directories,
special entries and uncounted placeholders or duplicate hard links do not.
Both category sums must equal the scan's file count and bytes; a mismatch fails
instead of displaying a partial breakdown. Empty scans retain eight zero rows.
Percentages use total scanned file bytes; displayed rounding may not sum to
100%, and a zero-byte scan shows 0%.

The scan root, access-error count and excluded/duplicate-entry count remain
visible. This describes scanned data, not the phone's complete physical storage
or Android app ownership. Root scans retain the existing read-only banner.
There are no deletion controls in this view. External device changes require a
rescan, as with the other snapshot views.

## Ownership and bounds

`Catalog::file_types_json` checks generation/revision before traversing the live
children index. The shared traversal also serves Largest files. Removing a
directory excludes its entire subtree; successful deletions update the revision
and totals through the existing deletion flow. Failed or partial deletions still
invalidate the snapshot through that flow.

Each query takes O(N) time with O(depth + 8) traversal/aggregation state and a
temporary suffix string bounded by the current filename. There is no additional
persistent index or full-tree copy. Exactly eight category records cross IPC;
filenames and paths are not returned. The existing response-size cap applies.
The command uses the existing scan-store lock, so it observes one coherent
revision. Switching away and returning runs another host query.

The frontend validates safe integer counts, all eight unique known categories,
matching scan identity, both sums and the expected scan totals. It hides stale
values immediately and ignores late results after rescan, revision change or
unmount. Query errors offer Retry.

The feature adapts the file-type breakdown idea tracked in #34 from
[Shanmukh's fork](https://github.com/ksaishanmukh/SocketSweep/tree/d677b530e00dec75c305fc56318720aa8c161692)
(commits `670736d`, `0aca98a`) to the existing host catalog. It adds no dependency
or device daemon change.

## Validation

Rust fixtures cover all categories, filename boundaries, unknown extensions,
zero bytes, read-only counting, excluded placeholders, empty scans, deleted
subtrees, stale scopes and reconciliation failure. A 20,000-distinct-extension
fixture still returns eight categories in less than 1 KiB.

A host-only release experiment reused the synthetic stream and 31-query,
three-process method from `tests/benchmark_largest_files.py`, substituting
`Catalog::file_types_json` for the ranking query. With 250,000 files in 32
folders, every response contained eight categories and was 434 bytes. Process
median query times were 35.6–43.3 ms on this arm64 macOS machine. These are host
aggregation timings under local load, not Android traversal measurements or a
scan-speed improvement claim.

Node tests reject malformed, stale, duplicated, unsafe or inconsistent summaries.
The built UI replay uses mocked IPC in headless Chrome to check eight rows,
rescan races, errors/retry, malformed results, deletion revisions, coverage,
read-only context, empty scans, horizontal layout and no implicit device scan.
These are host-only automated checks, not physical-device validation.

For a manual check, restart `npm run tauri dev`, scan normally and select
**File types**. Compare its Total with the scan header, then switch views and
rescan. No Android daemon rebuild is required for this host-side feature.
