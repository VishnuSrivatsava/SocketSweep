//! Comparable totals for verified scans. Only a completion that passed the
//! stream decoder and published a catalog may be recorded; failed, cancelled
//! or truncated scans never become baselines.
use crate::scan_store::Catalog;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Bump when daemon counting or exclusion rules change the meaning of the
/// stored totals (v1: regular files and directories counted separately,
/// st_size bytes, symlink/`.`/`..` exclusion everywhere; root read-only adds
/// serial traversal, inode deduplication, virtual-filesystem and root mount
/// alias exclusions). Old entries stay unread comparisons, not false deltas.
pub(crate) const COUNTING_SEMANTICS: u32 = 1;
const FORMAT_VERSION: u32 = 1;
const MAX_PER_KEY: usize = 10;
const MAX_ENTRIES: usize = 100;
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_SAFE_INTEGER: u64 = (1u64 << 53) - 1;
const MAX_TIMESTAMP: u64 = 8_640_000_000_000;
const MAX_SERIAL_BYTES: usize = 512;
const MAX_ROOT_BYTES: usize = 16 * 1024;
const FILE_NAME: &str = "scan-history.json";
const LOCK_NAME: &str = "scan-history.lock";
const TEMP_PREFIX: &str = "scan-history.json.tmp-";
const INVALID_PREFIX: &str = "scan-history.invalid-";

// Serialize local callers too; the persistent OS lock below protects the
// complete read/modify/replace transaction across app instances.
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AccessMode {
    Shell,
    RootReadOnly,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExclusionPolicy {
    /// Shell traversal: only symlinks, `.` and `..` are excluded.
    SymlinksOnly,
    /// Root read-only: adds inode deduplication, virtual filesystems and
    /// root mount aliases.
    RootDeduplicated,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Hash, Debug)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoryKey {
    serial: String,
    /// The daemon-confirmed root: realpath-resolved in root mode, and
    /// compared against the requested root otherwise.
    root: String,
    access: AccessMode,
    exclusions: ExclusionPolicy,
    counting_semantics: u32,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoryEntry {
    key: HistoryKey,
    total_files: u64,
    total_dirs: u64,
    total_size: u64,
    recorded_at: u64,
    skipped: u64,
}

impl HistoryEntry {
    pub(crate) fn new(
        serial: &str,
        root: &str,
        read_only: bool,
        total_files: u64,
        total_dirs: u64,
        total_size: u64,
        recorded_at: u64,
    ) -> Result<Self, String> {
        let entry = Self {
            key: HistoryKey {
                serial: serial.to_string(),
                root: root.to_string(),
                access: if read_only {
                    AccessMode::RootReadOnly
                } else {
                    AccessMode::Shell
                },
                exclusions: if read_only {
                    ExclusionPolicy::RootDeduplicated
                } else {
                    ExclusionPolicy::SymlinksOnly
                },
                counting_semantics: COUNTING_SEMANTICS,
            },
            total_files,
            total_dirs,
            total_size,
            recorded_at,
            skipped: 0,
        };
        entry.validate()?;
        Ok(entry)
    }

    fn validate(&self) -> Result<(), String> {
        let serial = self.key.serial.as_bytes();
        if serial.is_empty()
            || serial.len() > MAX_SERIAL_BYTES
            || serial.iter().any(|b| b.is_ascii_control())
        {
            return Err("Invalid history device serial".into());
        }
        let root = self.key.root.as_bytes();
        if !self.key.root.starts_with('/')
            || root.len() > MAX_ROOT_BYTES
            || root.contains(&0)
            || (self.key.root.len() > 1 && self.key.root.ends_with('/'))
        {
            return Err("Invalid history scan root".into());
        }
        if self.key.counting_semantics == 0 {
            return Err("Invalid history counting semantics".into());
        }
        for value in [
            self.total_files,
            self.total_dirs,
            self.total_size,
            self.recorded_at,
            self.skipped,
        ] {
            if value > MAX_SAFE_INTEGER {
                return Err("History totals exceed the exact integer range".into());
            }
        }
        if self.total_dirs == 0
            || (self.total_files == 0 && self.total_size != 0)
            || !matches!(
                (self.key.access, self.key.exclusions),
                (AccessMode::Shell, ExclusionPolicy::SymlinksOnly)
                    | (AccessMode::RootReadOnly, ExclusionPolicy::RootDeduplicated)
            )
        {
            return Err("Invalid history counting or exclusion metadata".into());
        }
        if self.recorded_at == 0 || self.recorded_at > MAX_TIMESTAMP {
            return Err("History entries require a recording time".into());
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HistoryFile {
    format_version: u32,
    entries: Vec<HistoryEntry>,
}

/// The outcome of recording: the immediately previous baseline for the same
/// key, if a comparable scan was recorded before this one.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Recorded {
    pub(crate) previous: Option<HistoryEntry>,
}

fn history_path(directory: &Path) -> PathBuf {
    directory.join(FILE_NAME)
}

enum Loaded {
    Missing,
    Entries(Vec<HistoryEntry>),
    /// A file this version cannot interpret; it must stay untouched.
    UnsupportedFormat,
    Corrupt(String),
}

// Refuse symlinks and special files before opening; platform flags also
// prevent a swapped symlink/FIFO from being followed or blocking the caller.
fn open_regular(path: &Path, create: bool) -> std::io::Result<std::fs::File> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(std::io::Error::other("History path is not a regular file"));
        }
        Err(error) if !(create && error.kind() == std::io::ErrorKind::NotFound) => {
            return Err(error)
        }
        _ => {}
    }
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .write(create)
        .create(create)
        .truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::other("History path is not a regular file"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            // FILE_ATTRIBUTE_REPARSE_POINT
            return Err(std::io::Error::other("History path is a reparse point"));
        }
    }
    Ok(file)
}

fn load(path: &Path) -> Result<Loaded, String> {
    let file = match open_regular(path, false) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Loaded::Missing),
        Err(error) => return Err(format!("Cannot read the history file: {error}")),
    };
    // Read at most the budget plus one byte, even if another program grows it.
    // Oversized files may belong to a newer format; leave them untouched.
    let mut bytes = Vec::new();
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read the history file: {e}"))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("History file exceeds its size bound and was left unchanged".into());
    }
    #[derive(Deserialize)]
    struct Version {
        format_version: u32,
    }
    let parsed = (|| -> Result<Loaded, String> {
        let version: Version = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if version.format_version != FORMAT_VERSION {
            return Ok(Loaded::UnsupportedFormat);
        }
        let parsed: HistoryFile = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if parsed.entries.len() > MAX_ENTRIES {
            return Err("History file exceeds its entry bound".into());
        }
        for entry in &parsed.entries {
            entry.validate()?;
        }
        Ok(Loaded::Entries(parsed.entries))
    })();
    // Only malformed content is quarantined, never an I/O/permission failure.
    Ok(parsed.unwrap_or_else(Loaded::Corrupt))
}

/// Quarantine an unreadable file by renaming it aside. The bytes stay on
/// disk for inspection; recording then starts a fresh history.
fn quarantine(path: &Path, now_ns: u128) -> Result<(), String> {
    let quarantine_path = path.with_file_name(format!("{INVALID_PREFIX}{now_ns}.json"));
    if quarantine_path.exists() {
        return Err("Cannot quarantine the history file uniquely".into());
    }
    std::fs::rename(path, &quarantine_path)
        .map_err(|e| format!("Cannot quarantine the corrupt history file: {e}"))
}

/// Only called under the cross-process lock: no cooperating writer can own
/// one of these temporaries while cleanup runs. Never remove the lock file.
fn remove_stale_temporaries(directory: &Path) {
    let Ok(children) = std::fs::read_dir(directory) else {
        return;
    };
    for child in children.flatten() {
        if child
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(TEMP_PREFIX))
        {
            let _ = std::fs::remove_file(child.path());
        }
    }
}

fn nanos_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_nanos())
        .unwrap_or_default()
}

/// Append one verified completion and return the previous comparable
/// baseline. The replacement is atomic: one rename publishes the new file,
/// or the previous content survives untouched.
pub(crate) fn record(directory: &Path, entry: HistoryEntry) -> Result<Recorded, String> {
    entry.validate()?;
    let _guard = FILE_LOCK
        .lock()
        .map_err(|_| "History state is unavailable")?;
    let path = history_path(directory);
    std::fs::create_dir_all(directory)
        .map_err(|e| format!("Cannot create the history directory: {e}"))?;
    let lock = open_regular(&directory.join(LOCK_NAME), true)
        .map_err(|e| format!("Cannot open the history lock: {e}"))?;
    lock.try_lock()
        .map_err(|e| format!("History is busy or cannot be locked: {e}"))?;
    let mut entries = match load(&path)? {
        Loaded::Missing => Vec::new(),
        Loaded::Entries(entries) => entries,
        Loaded::UnsupportedFormat => {
            return Err("Unsupported history format; file was left unchanged".into())
        }
        Loaded::Corrupt(error) => {
            // Malformed bytes are preserved for inspection. Other I/O errors
            // return before this branch, leaving the baseline untouched.
            quarantine(&path, nanos_now()).map_err(|q| format!("{error}; {q}"))?;
            eprintln!("Malformed scan history was quarantined; starting a new history");
            Vec::new()
        }
    };
    let previous = entries
        .iter()
        .rev()
        .find(|recorded| recorded.key == entry.key && recorded.skipped == entry.skipped)
        .cloned();
    entries.push(entry);
    // Keep the newest MAX_PER_KEY entries of every key, then the newest
    // MAX_ENTRIES entries overall; insertion order defines recency.
    let mut kept = vec![0usize; entries.len()];
    let mut per_key = HashMap::new();
    for (index, kept) in kept.iter_mut().enumerate().rev() {
        let seen = per_key.entry(entries[index].key.clone()).or_insert(0usize);
        *kept = *seen;
        *seen += 1;
    }
    let mut retained: Vec<_> = entries
        .into_iter()
        .zip(kept)
        .filter(|(_, seen)| *seen < MAX_PER_KEY)
        .map(|(entry, _)| entry)
        .collect();
    let overflow = retained.len().saturating_sub(MAX_ENTRIES);
    retained.drain(..overflow);
    let mut history = HistoryFile {
        format_version: FORMAT_VERSION,
        entries: retained,
    };
    let contents = loop {
        let contents = serde_json::to_vec(&history)
            .map_err(|e| format!("Cannot encode the history file: {e}"))?;
        if contents.len() <= MAX_FILE_BYTES {
            break contents;
        }
        if history.entries.len() <= 1 {
            return Err("History entry exceeds its size bound".into());
        }
        history.entries.remove(0);
    };
    remove_stale_temporaries(directory);
    let temporary = directory.join(format!(
        "{TEMP_PREFIX}{}-{}",
        std::process::id(),
        nanos_now()
    ));
    // Exclusive creation cannot truncate an existing file or follow a symlink.
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|e| format!("Cannot create the history file: {e}"))?;
    struct Temporary(PathBuf);
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _cleanup = Temporary(temporary.clone());
    let written = file.write_all(&contents).and_then(|()| file.sync_all());
    drop(file); // Windows replacement also needs our write handle closed.
    written.map_err(|e| format!("Cannot write the history file: {e}"))?;
    std::fs::rename(&temporary, &path)
        .map_err(|e| format!("Cannot publish the history file: {e}"))?;
    // Atomic visibility and crash durability are distinct. Sync directory
    // metadata on Unix; Windows has no equivalent portable std operation.
    #[cfg(unix)]
    std::fs::File::open(directory)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| format!("History was published but directory sync failed: {e}"))?;
    Ok(Recorded { previous })
}

pub(crate) fn completed_entry(serial: &str, catalog: &Catalog) -> Result<HistoryEntry, String> {
    let (errors, skipped) = catalog.coverage();
    if errors != 0 {
        return Err("Scans with access errors are not recorded as history baselines".into());
    }
    let recorded_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| "Clock is before the Unix epoch".to_string())?;
    let mut entry = HistoryEntry::new(
        serial,
        catalog.root_path(),
        catalog.read_only(),
        catalog.total_files(),
        catalog.total_dirs(),
        catalog.total_size(),
        recorded_at,
    )?;
    entry.skipped = skipped;
    entry.validate()?;
    Ok(entry)
}

// ── Current-scan comparison ──────────────────────────────────────────────────

struct Noted {
    previous: Option<HistoryEntry>,
}
static COMPARISON: Mutex<Option<(String, Noted)>> = Mutex::new(None);

pub(crate) fn note_comparison(generation: String, previous: Option<HistoryEntry>) {
    if let Ok(mut comparison) = COMPARISON.lock() {
        *comparison = Some((generation, Noted { previous }));
    }
}

pub(crate) fn clear_comparison() {
    if let Ok(mut comparison) = COMPARISON.lock() {
        *comparison = None;
    }
}

#[derive(Serialize)]
struct Previous {
    recorded_at: u64,
    total_files: u64,
    total_dirs: u64,
    total_size: u64,
}

#[derive(Serialize)]
struct Delta {
    files: i64,
    dirs: i64,
    size: i64,
}

#[derive(Serialize)]
struct Comparison {
    generation: String,
    revision: u32,
    first: bool,
    previous: Option<Previous>,
    delta: Option<Delta>,
}

/// Deltas come from the live catalog, so deletions keep the comparison
/// consistent with the totals the UI shows now, not just at scan time.
pub(crate) fn comparison_json(
    catalog: &Catalog,
    generation: &str,
    revision: u32,
) -> Result<String, String> {
    catalog.require_scope(generation, revision)?;
    let previous = COMPARISON
        .lock()
        .map_err(|_| "History state is unavailable")?
        .as_ref()
        .filter(|(noted_generation, _)| noted_generation.as_str() == generation)
        .map(|(_, noted)| noted.previous.clone())
        .ok_or("No comparison available for this scan")?;
    let Some(previous) = previous else {
        return serde_json::to_string(&Comparison {
            generation: generation.to_string(),
            revision,
            first: true,
            previous: None,
            delta: None,
        })
        .map_err(|e| e.to_string());
    };
    // Totals are bounded by MAX_SAFE_INTEGER, so signed differences cannot
    // overflow the exact integer range.
    serde_json::to_string(&Comparison {
        generation: generation.to_string(),
        revision,
        first: false,
        previous: Some(Previous {
            recorded_at: previous.recorded_at,
            total_files: previous.total_files,
            total_dirs: previous.total_dirs,
            total_size: previous.total_size,
        }),
        delta: Some(Delta {
            files: catalog.total_files() as i64 - previous.total_files as i64,
            dirs: catalog.total_dirs() as i64 - previous.total_dirs as i64,
            size: catalog.total_size() as i64 - previous.total_size as i64,
        }),
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan_stream::{self, Response};
    use serde_json::{json, Value};
    use std::io::Cursor as Reader;

    struct Directory(PathBuf);
    impl Directory {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            Self(std::env::temp_dir().join(format!(
                "socketsweep-history-{tag}-{}-{nanos}",
                std::process::id()
            )))
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn write(&self, bytes: &[u8]) {
            std::fs::create_dir_all(&self.0).unwrap();
            std::fs::write(history_path(&self.0), bytes).unwrap();
        }
        fn read(&self) -> Vec<u8> {
            std::fs::read(history_path(&self.0)).unwrap()
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn entry(
        serial: &str,
        root: &str,
        read_only: bool,
        files: u64,
        size: u64,
        at: u64,
    ) -> HistoryEntry {
        HistoryEntry::new(serial, root, read_only, files, 3, size, at).unwrap()
    }

    fn parsed(directory: &Directory) -> HistoryFile {
        serde_json::from_slice(&directory.read()).unwrap()
    }

    fn response(size: u64) -> Response {
        fn frame(kind: &str, data: Value) -> Vec<u8> {
            let data = serde_json::to_vec(&json!({"type":kind,"data":data})).unwrap();
            let mut bytes = (data.len() as u32).to_be_bytes().to_vec();
            bytes.extend(data);
            bytes
        }
        let entries = vec![
            json!({"id":0,"parent":null,"name":"fixture","kind":"directory","size":0,"counted":true}),
            json!({"id":1,"parent":0,"name":"leaf","kind":"file","size":size,"counted":true}),
        ];
        let mut bytes = frame(
            "started",
            json!({"stream_version":1,"root":"/fixture","read_only":false}),
        );
        bytes.extend(frame("entries", json!({"entries":entries})));
        let count = bytes.len();
        bytes.extend(frame(
            "done",
            json!({"total_files":1,"total_dirs":1,"total_size":size,"errors":0,
                "skipped":0,"scan_time_ms":1,"scan_threads":4,"serialize_ms":0,
                "send_ms":0,"bytes_sent":count}),
        ));
        scan_stream::read(&mut Reader::new(bytes), false, |_| Ok(())).unwrap()
    }

    #[test]
    fn keys_separate_devices_roots_and_access_modes() {
        let directory = Directory::new("keys");
        let first = record(
            directory.path(),
            entry("phone-a", "/sdcard", false, 10, 100, 1),
        )
        .unwrap();
        assert_eq!(first.previous, None);
        let other_device = record(
            directory.path(),
            entry("phone-b", "/sdcard", false, 20, 200, 2),
        )
        .unwrap();
        assert_eq!(other_device.previous, None);
        let other_root = record(
            directory.path(),
            entry("phone-a", "/data", false, 30, 300, 3),
        )
        .unwrap();
        assert_eq!(other_root.previous, None);
        let other_mode = record(
            directory.path(),
            entry("phone-a", "/sdcard", true, 40, 400, 4),
        )
        .unwrap();
        assert_eq!(other_mode.previous, None);
        let same = record(
            directory.path(),
            entry("phone-a", "/sdcard", false, 50, 500, 5),
        )
        .unwrap();
        let previous = same.previous.unwrap();
        assert_eq!((previous.total_files, previous.total_size), (10, 100));
        let file = parsed(&directory);
        assert_eq!(file.format_version, FORMAT_VERSION);
        assert_eq!(file.entries.len(), 5);
        assert_eq!(file.entries.last().unwrap().recorded_at, 5);
    }

    #[test]
    fn root_paths_serials_and_totals_validate_before_any_write() {
        assert!(HistoryEntry::new("phone", "/sdcard/backup", false, 0, 1, 0, 1).is_ok());
        assert!(HistoryEntry::new("phone", "/", true, 0, 1, 0, 1).is_ok());
        for root in ["sdcard", "", "/sdcard/", "/a\0b"] {
            assert!(
                HistoryEntry::new("phone", root, false, 0, 1, 0, 1).is_err(),
                "{root}"
            );
        }
        for serial in ["", "phone\n", &"x".repeat(MAX_SERIAL_BYTES + 1)] {
            assert!(
                HistoryEntry::new(serial, "/sdcard", false, 0, 1, 0, 1).is_err(),
                "{serial:?}"
            );
        }
        for at in [0, MAX_SAFE_INTEGER + 1] {
            assert!(
                HistoryEntry::new("phone", "/sdcard", false, 0, 1, 0, at).is_err(),
                "{at}"
            );
        }
        assert!(
            HistoryEntry::new("phone", "/sdcard", false, MAX_SAFE_INTEGER + 1, 1, 0, 1).is_err()
        );
        let directory = Directory::new("validate");
        // Directly constructed entries keep record()'s own validation testable.
        let relative_root = HistoryEntry {
            key: HistoryKey {
                serial: "phone".into(),
                root: "relative".into(),
                access: AccessMode::Shell,
                exclusions: ExclusionPolicy::SymlinksOnly,
                counting_semantics: COUNTING_SEMANTICS,
            },
            total_files: 1,
            total_dirs: 1,
            total_size: 1,
            recorded_at: 1,
            skipped: 0,
        };
        assert!(record(directory.path(), relative_root).is_err());
        assert!(!history_path(directory.path()).exists());
    }

    #[test]
    fn interrupted_writes_and_corrupt_files_are_quarantined_not_deleted() {
        let directory = Directory::new("corrupt");
        directory.write(b"{\"format_version\":1,\"entries\":[{\"key\"");
        let result = record(directory.path(), entry("phone", "/sdcard", false, 1, 1, 1)).unwrap();
        assert_eq!(result.previous, None);
        let children: Vec<String> = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|child| child.unwrap().file_name().to_str().unwrap().into())
            .collect();
        assert_eq!(children.len(), 3, "{children:?}");
        let quarantined = children
            .iter()
            .find(|name| name.starts_with(INVALID_PREFIX))
            .unwrap();
        assert_eq!(
            std::fs::read(directory.path().join(quarantined)).unwrap(),
            b"{\"format_version\":1,\"entries\":[{\"key\""
        );
        assert_eq!(parsed(&directory).entries.len(), 1);
    }

    #[test]
    fn oversized_and_invalid_entry_files_restart_the_history() {
        let directory = Directory::new("invalid");
        directory.write(&vec![b'x'; MAX_FILE_BYTES + 1]);
        assert!(record(directory.path(), entry("phone", "/sdcard", false, 1, 1, 1)).is_err());
        assert_eq!(directory.read(), vec![b'x'; MAX_FILE_BYTES + 1]);
        // Valid JSON with impossible entries is corrupt, not a baseline.
        let bad_entries = serde_json::to_vec(&HistoryFile {
            format_version: FORMAT_VERSION,
            entries: vec![HistoryEntry {
                key: HistoryKey {
                    serial: "phone".into(),
                    root: "/sdcard".into(),
                    access: AccessMode::Shell,
                    exclusions: ExclusionPolicy::SymlinksOnly,
                    counting_semantics: COUNTING_SEMANTICS,
                },
                total_files: MAX_SAFE_INTEGER + 1,
                total_dirs: 0,
                total_size: 0,
                recorded_at: 9,
                skipped: 0,
            }],
        })
        .unwrap();
        directory.write(&bad_entries);
        let result = record(directory.path(), entry("phone", "/sdcard", false, 1, 1, 1)).unwrap();
        assert_eq!(result.previous, None);
        assert_eq!(parsed(&directory).entries.len(), 1);
    }

    #[test]
    fn newer_format_files_are_preserved_without_recording() {
        let directory = Directory::new("newer");
        let newer =
            b"{\"format_version\":2,\"entries\":[{\"future_schema\":true}],\"new_field\":1}";
        directory.write(newer);
        let error =
            record(directory.path(), entry("phone", "/sdcard", false, 1, 1, 1)).unwrap_err();
        assert!(error.contains("Unsupported history format"), "{error}");
        assert_eq!(directory.read(), newer);
    }

    #[test]
    fn retention_bounds_each_key_and_the_whole_file() {
        let directory = Directory::new("retention");
        for number in 1..=12u64 {
            record(
                directory.path(),
                entry("phone", "/sdcard", false, number, number, number),
            )
            .unwrap();
        }
        let file = parsed(&directory);
        assert_eq!(file.entries.len(), MAX_PER_KEY);
        assert_eq!(
            file.entries
                .iter()
                .map(|entry| entry.recorded_at)
                .collect::<Vec<_>>(),
            (3..=12).collect::<Vec<_>>()
        );
        let latest = record(
            directory.path(),
            entry("phone", "/sdcard", false, 13, 13, 13),
        )
        .unwrap();
        assert_eq!(latest.previous.unwrap().recorded_at, 12);
        for number in 1..=95u64 {
            record(
                directory.path(),
                entry(
                    "phone",
                    &format!("/root-{number}"),
                    false,
                    number,
                    number,
                    number,
                ),
            )
            .unwrap();
        }
        let file = parsed(&directory);
        assert_eq!(file.entries.len(), MAX_ENTRIES);
        // The overall bound dropped the oldest same-key entries first.
        let sdcard: Vec<_> = file
            .entries
            .iter()
            .filter(|entry| entry.key.root == "/sdcard")
            .map(|entry| entry.recorded_at)
            .collect();
        assert_eq!(sdcard, (9..=13).collect::<Vec<_>>());
        assert_eq!(
            file.entries
                .iter()
                .filter(|entry| entry.key.root.starts_with("/root-"))
                .count(),
            95
        );
    }

    #[test]
    fn stale_temporaries_are_removed_and_successful_writes_leave_none() {
        let directory = Directory::new("temporaries");
        record(directory.path(), entry("phone", "/sdcard", false, 1, 1, 1)).unwrap();
        let original = directory.read();
        let stale = directory.path().join(format!("{TEMP_PREFIX}stale"));
        std::fs::write(&stale, b"interrupted").unwrap();
        match load(&history_path(directory.path())).unwrap() {
            Loaded::Entries(entries) => assert_eq!(entries[0].total_files, 1),
            _ => panic!("Interrupted temporary replaced the baseline"),
        }
        assert_eq!(directory.read(), original);
        let recorded = record(directory.path(), entry("phone", "/sdcard", false, 2, 2, 2)).unwrap();
        assert_eq!(recorded.previous.unwrap().total_files, 1);
        assert!(!stale.exists());
        let children: Vec<String> = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|child| child.unwrap().file_name().to_str().unwrap().into())
            .collect();
        assert_eq!(children.len(), 2);
        assert!(children.contains(&FILE_NAME.to_string()));
        assert!(children.contains(&LOCK_NAME.to_string()));
    }

    #[test]
    #[cfg(unix)]
    fn unwritable_directories_fail_without_losing_the_previous_baseline() {
        use std::os::unix::fs::PermissionsExt;
        let directory = Directory::new("unwritable");
        record(directory.path(), entry("phone", "/sdcard", false, 1, 1, 1)).unwrap();
        let permissions = std::fs::metadata(directory.path()).unwrap().permissions();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        assert!(record(directory.path(), entry("phone", "/sdcard", false, 2, 2, 2)).is_err());
        std::fs::set_permissions(directory.path(), permissions).unwrap();
        assert_eq!(parsed(&directory).entries.len(), 1);
        let previous = record(directory.path(), entry("phone", "/sdcard", false, 2, 2, 2))
            .unwrap()
            .previous;
        assert_eq!(previous.unwrap().recorded_at, 1);
    }

    #[test]
    fn a_blocked_history_path_fails_without_moving_anything_aside() {
        let directory = Directory::new("blocked");
        std::fs::create_dir_all(history_path(directory.path())).unwrap();
        assert!(record(directory.path(), entry("phone", "/sdcard", false, 1, 1, 1)).is_err());
        assert!(history_path(directory.path()).is_dir());
    }

    #[test]
    fn comparison_deltas_track_the_live_catalog_and_scope() {
        let _operation = crate::DAEMON_OPERATION.lock().unwrap();
        let catalog = crate::scan_store::Catalog::new(response(70), "generation-a".into());
        note_comparison(
            "generation-a".into(),
            Some(entry("phone", "/fixture", false, 6, 50, 1)),
        );
        let raw = comparison_json(&catalog, "generation-a", 0).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["first"], false);
        assert_eq!(value["previous"]["total_size"], 50);
        assert_eq!(value["previous"]["recorded_at"], 1);
        assert_eq!(value["delta"]["files"], -5);
        assert_eq!(value["delta"]["dirs"], -2);
        assert_eq!(value["delta"]["size"], 20);
        // Repeated queries are consistent; wrong scopes never compare.
        assert_eq!(
            serde_json::from_str::<Value>(&comparison_json(&catalog, "generation-a", 0).unwrap())
                .unwrap()["delta"]["size"],
            20
        );
        assert!(comparison_json(&catalog, "old", 0).is_err());
        assert!(comparison_json(&catalog, "generation-a", 1).is_err());
        // Another generation's note never serves this catalog.
        note_comparison("generation-b".into(), None);
        assert!(comparison_json(&catalog, "generation-a", 0).is_err());
        clear_comparison();
        let fresh = crate::scan_store::Catalog::new(response(70), "generation-b".into());
        note_comparison("generation-b".into(), None);
        let raw = comparison_json(&fresh, "generation-b", 0).unwrap();
        assert_eq!(
            raw,
            include_str!("../../tests/fixtures/scan-history-first.json").trim()
        );
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["first"], true);
        clear_comparison();
        assert!(comparison_json(&fresh, "generation-b", 0).is_err());
    }

    #[test]
    fn recording_reports_positive_negative_and_zero_directions() {
        let directory = Directory::new("directions");
        record(
            directory.path(),
            entry("phone", "/sdcard", false, 60, 50, 1),
        )
        .unwrap();
        let same = record(
            directory.path(),
            entry("phone", "/sdcard", false, 60, 50, 2),
        )
        .unwrap();
        assert_eq!(same.previous.unwrap().total_size, 50);
        let grew = record(
            directory.path(),
            entry("phone", "/sdcard", false, 70, 60, 3),
        )
        .unwrap();
        assert_eq!(grew.previous.unwrap().total_files, 60);
        let shrank = record(directory.path(), entry("phone", "/sdcard", false, 10, 5, 4)).unwrap();
        assert_eq!(shrank.previous.unwrap().total_size, 60);
        let file = parsed(&directory);
        assert_eq!(file.entries.len(), 4);
        assert_eq!(file.entries.last().unwrap().total_files, 10);
    }
    #[test]
    fn access_errors_do_not_replace_history_and_exclusion_counts_must_match() {
        let directory = Directory::new("coverage");
        let catalog = Catalog::new(response(7), "coverage".into());
        record(
            directory.path(),
            completed_entry("phone", &catalog).unwrap(),
        )
        .unwrap();
        let original = directory.read();
        let mut partial = response(3);
        partial.errors = 1;
        let partial = Catalog::new(partial, "partial".into());
        assert!(completed_entry("phone", &partial).is_err());
        assert_eq!(directory.read(), original);
        let mut excluded = response(3);
        excluded.skipped = 2;
        let excluded = Catalog::new(excluded, "excluded".into());
        let changed = completed_entry("phone", &excluded).unwrap();
        assert!(record(directory.path(), changed.clone())
            .unwrap()
            .previous
            .is_none());
        assert!(record(directory.path(), changed)
            .unwrap()
            .previous
            .is_some());
    }

    #[test]
    fn long_comparison_keys_evict_old_entries_to_meet_the_byte_budget() {
        let directory = Directory::new("bytes");
        for n in 1..=20 {
            let root = format!("/{}-{n}", "x".repeat(MAX_ROOT_BYTES - 8));
            record(directory.path(), entry("phone", &root, false, n, n, n)).unwrap();
        }
        let stored = parsed(&directory);
        assert!(stored.entries.len() < 20);
        assert_eq!(stored.entries.last().unwrap().recorded_at, 20);
        assert!(directory.read().len() <= MAX_FILE_BYTES);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_and_unreadable_files_are_not_moved_or_replaced() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = Directory::new("symlink");
        std::fs::create_dir_all(directory.path()).unwrap();
        let target = directory.path().join("target.json");
        std::fs::write(&target, b"fixture target").unwrap();
        let path = history_path(directory.path());
        symlink(&target, &path).unwrap();
        assert!(record(directory.path(), entry("phone", "/sdcard", false, 1, 1, 1)).is_err());
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&target).unwrap(), b"fixture target");
        std::fs::remove_file(&path).unwrap();
        record(directory.path(), entry("phone", "/sdcard", false, 1, 1, 1)).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let original = directory.read();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0)).unwrap();
        assert!(record(directory.path(), entry("phone", "/sdcard", false, 2, 2, 2)).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(directory.read(), original);
        assert!(!std::fs::read_dir(directory.path())
            .unwrap()
            .any(|child| child
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(INVALID_PREFIX)));
    }

    #[test]
    fn another_process_cannot_lose_updates_or_remove_an_active_temporary() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        const CHILD: &str = "SOCKETSWEEP_HISTORY_LOCK_TEST";
        if let Some(path) = std::env::var_os(CHILD) {
            let directory = PathBuf::from(path);
            let lock = open_regular(&directory.join(LOCK_NAME), true).unwrap();
            lock.try_lock().unwrap();
            std::fs::write(directory.join("ready"), b"locked").unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !directory.join("release").exists() {
                assert!(
                    Instant::now() < deadline,
                    "Parent did not release lock test"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            return; // OS releases the lock even if this process exits abruptly.
        }
        let directory = Directory::new("process-lock");
        record(directory.path(), entry("phone", "/sdcard", false, 1, 1, 1)).unwrap();
        let original = directory.read();
        let temporary = directory.path().join(format!("{TEMP_PREFIX}active-writer"));
        std::fs::write(&temporary, b"in-progress").unwrap();
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut child = Child(Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "scan_history::tests::another_process_cannot_lose_updates_or_remove_an_active_temporary"])
            .env(CHILD, directory.path()).stdout(Stdio::null()).spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(5);
        while !directory.path().join("ready").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "Lock child exited early"
            );
            assert!(Instant::now() < deadline, "Lock child never became ready");
            std::thread::sleep(Duration::from_millis(10));
        }
        let error =
            record(directory.path(), entry("phone", "/sdcard", false, 2, 2, 2)).unwrap_err();
        assert!(error.contains("locked"), "{error}");
        assert_eq!(directory.read(), original);
        assert_eq!(std::fs::read(&temporary).unwrap(), b"in-progress");
        std::fs::write(directory.path().join("release"), b"release").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline, "Lock child did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
        let recorded = record(directory.path(), entry("phone", "/sdcard", false, 2, 2, 2)).unwrap();
        assert_eq!(recorded.previous.unwrap().total_files, 1);
        assert!(!temporary.exists());
    }
}
