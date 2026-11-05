# Package-folder usage

The Package folders view groups scanned directory bytes by package-style
folder ID. It uses the current Rust catalog and makes no device requests.
Package IDs come from directory names and may refer to removed apps. App names,
installation state, and complete app totals remain unknown.

Recognized directory layouts are:

- `/sdcard/Android/{data,obb,media}/<package>`
- `/storage/emulated/<numeric-user>/Android/{data,obb,media}/<package>`
- `/data/media/<numeric-user>/Android/{data,obb,media}/<package>`
- `/data/{user,user_de}/<numeric-user>/<package>`
- `/data/data/<package>`

Recognition uses exact absolute path components. It works when scanning shared
storage, `/data`, `/`, a listed parent location, or a package folder itself.
Unrelated folders named like packages are left unattributed. Folder IDs require
dot-separated ASCII components starting with a letter and containing letters,
digits, or underscores. Other names remain part of unattributed scanned bytes.

Each recognized directory contributes its catalog subtree size once.
Recognized paths cannot be nested inside one another. Uncounted alias or
exclusion placeholders contribute no package bytes. Root scans retain their
existing deduplication and read-only rules. The same ID is aggregated across
recognized locations and users within the scan.

For every response:

```
attributed_size + unattributed_size = total_size
```

These are scanned bytes. A directory entry with zero bytes can be empty or
unreadable. The protocol provides global error/exclusion counts without
per-directory completeness, so the view always states that complete totals and
missing or unreadable locations remain unknown. Private app storage outside
the scan cannot be inferred from shared-storage folders.

The response contains up to 100 package IDs per page, ordered by ID. Every
query requires the current generation and revision. Deletions recompute from
the live catalog and invalidate old pages. The summary provides no deletion
targets.

Validation covers shared-storage aliases, `/data` and `/` roots, a package
folder scanned directly, unrelated paths, zero-byte/error cases, alias
placeholders, complete paging through 205 IDs, and deletion revisions.
Frontend checks cover reconciliation, malformed/stale replies, retries,
paging, read-only mode, and empty results. Physical-device validation is
separate from the synthetic catalog and mocked browser tests.
