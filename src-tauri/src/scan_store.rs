//! One verified scan owns all records. UI IDs/cursors require its generation
//! and revision; paths are reconstructed here from exact validated names.
use crate::scan_stream::{Kind, Node, Response, NONE};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap};
use std::io::Write;
use std::ops::Bound::{Excluded, Unbounded};
use std::sync::Arc;
use std::time::Instant;

pub const PAGE_SIZE: usize = 128;
pub const MAX_LARGEST_FILES: usize = 100;
const CHART_SIZE: usize = 64;
const MAX_QUERY_BYTES: usize = 1024 * 1024;
type Key = (Reverse<u64>, Arc<str>, u32);

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum FileType {
    Images,
    Videos,
    Audio,
    Documents,
    Archives,
    AndroidPackages,
    NoExtension,
    Other,
}
impl FileType {
    const ALL: [Self; 8] = [
        Self::Images,
        Self::Videos,
        Self::Audio,
        Self::Documents,
        Self::Archives,
        Self::AndroidPackages,
        Self::NoExtension,
        Self::Other,
    ];

    // Filename metadata only: preserve whitespace, inspect the final suffix,
    // and treat a single leading dot or trailing dot as no extension.
    fn of(name: &str) -> Self {
        let Some((stem, suffix)) = name.rsplit_once('.') else {
            return Self::NoExtension;
        };
        if stem.is_empty() || suffix.is_empty() {
            return Self::NoExtension;
        }
        match suffix.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "heic" | "heif" | "avif" | "bmp" | "tif"
            | "tiff" | "svg" | "ico" | "dng" => Self::Images,
            "mp4" | "m4v" | "mkv" | "webm" | "avi" | "mov" | "3gp" | "3g2" | "mpeg" | "mpg"
            | "wmv" | "flv" => Self::Videos,
            "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus" | "wav" | "wma" | "amr" | "mid"
            | "midi" | "aiff" | "ape" | "oga" => Self::Audio,
            "pdf" | "txt" | "md" | "rtf" | "doc" | "docx" | "odt" | "xls" | "xlsx" | "ods"
            | "csv" | "ppt" | "pptx" | "odp" | "epub" | "mobi" => Self::Documents,
            "zip" | "7z" | "rar" | "tar" | "gz" | "bz2" | "xz" | "zst" | "tgz" | "tbz" | "tbz2"
            | "txz" => Self::Archives,
            "apk" | "apks" | "xapk" | "aab" => Self::AndroidPackages,
            _ => Self::Other,
        }
    }
}

pub struct Catalog {
    generation: String,
    revision: u32,
    response: Response,
    children: Vec<BTreeSet<Key>>,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Next,
    Previous,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    direction: Direction,
    node_id: u32,
}
#[derive(Serialize)]
struct NodeSummary<'a> {
    id: u32,
    parent_id: Option<u32>,
    name: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    size: u64,
    counted: bool,
    child_count: usize,
    can_delete: bool,
}
#[derive(Serialize)]
struct Summary<'a> {
    #[serde(flatten)]
    stats: &'a Response,
    generation: &'a str,
    revision: u32,
    root_path: &'a str,
    root: NodeSummary<'a>,
}
#[derive(Serialize)]
struct Breadcrumb<'a> {
    id: u32,
    name: &'a str,
}
#[derive(Serialize)]
struct Tile<'a> {
    node_id: Option<u32>,
    name: &'a str,
    size: u64,
}
#[derive(Serialize)]
struct View<'a> {
    generation: &'a str,
    revision: u32,
    node: NodeSummary<'a>,
    path: String,
    breadcrumbs: Vec<Breadcrumb<'a>>,
    children: Vec<NodeSummary<'a>>,
    previous_cursor: Option<Cursor>,
    next_cursor: Option<Cursor>,
    chart: Vec<Tile<'a>>,
}
// Prepared only while the operation lock is held. No frontend path enters a
// destructive command. Queries release their lock before any network I/O.
pub struct DeletePlan {
    generation: String,
    revision: u32,
    node_id: u32,
    pub path: String,
}

fn json(value: &impl Serialize) -> Result<String, String> {
    struct Limited(Vec<u8>);
    impl Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_QUERY_BYTES.saturating_sub(self.0.len()) {
                return Err(std::io::Error::other("Scan query exceeds response limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Limited(Vec::new());
    serde_json::to_writer(&mut output, value).map_err(|e| format!("Cannot display scan: {e}"))?;
    String::from_utf8(output.0).map_err(|_| "Invalid scan encoding".into())
}
impl Catalog {
    pub fn new(mut response: Response, generation: String) -> Self {
        let started = Instant::now();
        let mut children = vec![BTreeSet::new(); response.nodes.len()];
        for (id, node) in response.nodes.iter().enumerate().skip(1) {
            children[node.parent as usize].insert((
                Reverse(node.size),
                node.name.clone(),
                id as u32,
            ));
        }
        response.sort_ms += started.elapsed().as_millis() as u64;
        Self {
            generation,
            revision: 0,
            response,
            children,
        }
    }
    fn scope(&self, generation: &str, revision: u32) -> Result<(), String> {
        if generation != self.generation || revision != self.revision {
            return Err("Scan changed; refresh before continuing.".into());
        }
        Ok(())
    }
    /// Public generation/revision gate for sibling modules that serve
    /// snapshot-scoped queries without exposing catalog internals.
    pub fn require_scope(&self, generation: &str, revision: u32) -> Result<(), String> {
        self.scope(generation, revision)
    }
    pub fn coverage(&self) -> (u64, u64) {
        (self.response.errors, self.response.skipped)
    }
    pub fn root_path(&self) -> &str {
        &self.response.root
    }
    pub fn read_only(&self) -> bool {
        self.response.read_only
    }
    pub fn total_files(&self) -> u64 {
        self.response.total_files
    }
    pub fn total_dirs(&self) -> u64 {
        self.response.total_dirs
    }
    pub fn total_size(&self) -> u64 {
        self.response.total_size
    }
    fn node(&self, id: u32) -> Result<&Node, String> {
        let node = self
            .response
            .nodes
            .get(id as usize)
            .ok_or("Invalid scan node")?;
        let mut current = id;
        while current != NONE {
            let ancestor = &self.response.nodes[current as usize];
            if ancestor.deleted {
                return Err("Scan node is no longer available".into());
            }
            current = ancestor.parent;
        }
        Ok(node)
    }
    fn path(&self, id: u32) -> String {
        let mut names = Vec::new();
        let mut current = id;
        while current != 0 {
            let node = &self.response.nodes[current as usize];
            names.push(node.name.as_ref());
            current = node.parent;
        }
        let mut path = self.response.root.clone();
        for name in names.into_iter().rev() {
            if path != "/" {
                path.push('/');
            }
            path.push_str(name);
        }
        path
    }
    fn can_delete(&self, id: u32) -> bool {
        // Line protocol cannot represent CR/LF. Never replace or normalize
        // these bytes: show the entry, but require deletion outside this app.
        let path = self.path(id);
        id != 0
            && !self.response.read_only
            && path.len() + "DELETE ".len() <= crate::MAX_COMMAND_BYTES
            && !path.contains(['\r', '\n', '\0'])
    }
    fn summary_node(&self, id: u32) -> NodeSummary<'_> {
        let node = &self.response.nodes[id as usize];
        NodeSummary {
            id,
            parent_id: (node.parent != NONE).then_some(node.parent),
            name: &node.name,
            kind: if node.kind == Kind::Directory {
                "directory"
            } else {
                "file"
            },
            size: node.size,
            counted: node.counted,
            child_count: self.children[id as usize].len(),
            can_delete: self.can_delete(id),
        }
    }
    fn summary(&self) -> Summary<'_> {
        Summary {
            stats: &self.response,
            generation: &self.generation,
            revision: self.revision,
            root_path: &self.response.root,
            root: self.summary_node(0),
        }
    }
    pub fn summary_json(&self) -> Result<String, String> {
        json(&self.summary())
    }
    fn key(&self, id: u32) -> Key {
        let node = &self.response.nodes[id as usize];
        (Reverse(node.size), node.name.clone(), id)
    }
    pub fn view_json(
        &self,
        generation: &str,
        revision: u32,
        id: u32,
        cursor: Option<Cursor>,
    ) -> Result<String, String> {
        self.scope(generation, revision)?;
        self.node(id)?;
        let children = &self.children[id as usize];
        let keys: Vec<&Key> = if let Some(cursor) = cursor {
            let child = self.node(cursor.node_id)?;
            if child.parent != id {
                return Err("Invalid directory cursor".into());
            }
            let key = self.key(cursor.node_id);
            if !children.contains(&key) {
                return Err("Invalid directory cursor".into());
            }
            match cursor.direction {
                Direction::Next => children
                    .range((Excluded(key), Unbounded))
                    .take(PAGE_SIZE)
                    .collect(),
                Direction::Previous => {
                    let mut page: Vec<_> = children
                        .range((Unbounded, Excluded(key)))
                        .rev()
                        .take(PAGE_SIZE)
                        .collect();
                    page.reverse();
                    page
                }
            }
        } else {
            children.iter().take(PAGE_SIZE).collect()
        };
        // A fabricated boundary cursor must not hide a nonempty directory.
        if keys.is_empty() && !children.is_empty() {
            return Err("Directory cursor has no page".into());
        }
        let previous_cursor = keys
            .first()
            .filter(|key| {
                children
                    .range((Unbounded, Excluded((**key).clone())))
                    .next()
                    .is_some()
            })
            .map(|key| Cursor {
                direction: Direction::Previous,
                node_id: key.2,
            });
        let next_cursor = keys
            .last()
            .filter(|key| {
                children
                    .range((Excluded((**key).clone()), Unbounded))
                    .next()
                    .is_some()
            })
            .map(|key| Cursor {
                direction: Direction::Next,
                node_id: key.2,
            });
        let mut breadcrumbs = Vec::new();
        let mut current = id;
        while current != NONE {
            let node = &self.response.nodes[current as usize];
            breadcrumbs.push(Breadcrumb {
                id: current,
                name: &node.name,
            });
            current = node.parent;
        }
        breadcrumbs.reverse();
        let mut chart: Vec<_> = children
            .iter()
            .take(CHART_SIZE)
            .filter(|key| key.0 .0 > 0)
            .map(|key| Tile {
                node_id: Some(key.2),
                name: &key.1,
                size: key.0 .0,
            })
            .collect();
        let remainder =
            self.response.nodes[id as usize].size - chart.iter().map(|tile| tile.size).sum::<u64>();
        // File views have no children; their bytes must not become an Other tile.
        if remainder > 0 && !children.is_empty() {
            chart.push(Tile {
                node_id: None,
                name: "Other",
                size: remainder,
            });
        }
        json(&View {
            generation: &self.generation,
            revision: self.revision,
            node: self.summary_node(id),
            path: self.path(id),
            breadcrumbs,
            children: keys.iter().map(|key| self.summary_node(key.2)).collect(),
            previous_cursor,
            next_cursor,
            chart,
        })
    }
    /// Rank only live, counted regular files. Walking reachable children also
    /// excludes descendants of removed directories without another live index.
    /// The worst retained key is at the heap root: O(N log K), O(K + depth).
    pub fn largest_json(
        &self,
        generation: &str,
        revision: u32,
        limit: usize,
    ) -> Result<String, String> {
        self.scope(generation, revision)?;
        if !(1..=MAX_LARGEST_FILES).contains(&limit) {
            return Err(format!(
                "Largest-files limit must be between 1 and {MAX_LARGEST_FILES}"
            ));
        }
        let mut best = BinaryHeap::<Key>::with_capacity(limit);
        self.visit_files(|key, _| {
            if best.len() < limit {
                best.push(key.clone());
            } else if key < best.peek().unwrap() {
                *best.peek_mut().unwrap() = key.clone();
            }
        });
        #[derive(Serialize)]
        struct File<'a> {
            node: NodeSummary<'a>,
            path: String,
        }
        #[derive(Serialize)]
        struct Largest<'a> {
            generation: &'a str,
            revision: u32,
            limit: usize,
            total_files: u64,
            files: Vec<File<'a>>,
        }
        let files = best
            .into_sorted_vec()
            .into_iter()
            .map(|key| File {
                node: self.summary_node(key.2),
                path: self.path(key.2),
            })
            .collect();
        json(&Largest {
            generation: &self.generation,
            revision: self.revision,
            limit,
            total_files: self.response.total_files,
            files,
        })
        .map_err(|error| format!("{error}. Try a smaller file limit."))
    }
    // Traverse the live index, so removed directories' descendants are absent.
    // Both analyses use O(depth) traversal state rather than copying the tree.
    fn visit_files(&self, mut visit: impl FnMut(&Key, &Node)) {
        let mut pending = vec![self.children[0].iter()];
        while let Some(children) = pending.last_mut() {
            if let Some(key) = children.next() {
                let node = &self.response.nodes[key.2 as usize];
                if node.kind == Kind::Directory {
                    pending.push(self.children[key.2 as usize].iter());
                } else if node.kind == Kind::File && node.counted {
                    visit(key, node);
                }
            } else {
                pending.pop();
            }
        }
    }

    pub fn file_types_json(&self, generation: &str, revision: u32) -> Result<String, String> {
        self.scope(generation, revision)?;
        #[derive(Serialize)]
        struct Category {
            kind: FileType,
            files: u64,
            size: u64,
        }
        let mut categories = FileType::ALL.map(|kind| Category {
            kind,
            files: 0,
            size: 0,
        });
        self.visit_files(|_, node| {
            let category = &mut categories[FileType::of(&node.name) as usize];
            category.files += 1;
            category.size += node.size;
        });
        if categories.iter().map(|c| c.files).sum::<u64>() != self.response.total_files
            || categories.iter().map(|c| c.size).sum::<u64>() != self.response.total_size
        {
            return Err("File-type totals do not match this scan; rescan required".into());
        }
        #[derive(Serialize)]
        struct Breakdown<'a> {
            generation: &'a str,
            revision: u32,
            total_files: u64,
            total_size: u64,
            categories: [Category; 8],
        }
        json(&Breakdown {
            generation: &self.generation,
            revision: self.revision,
            total_files: self.response.total_files,
            total_size: self.response.total_size,
            categories,
        })
    }

    pub fn detail_json(&self, generation: &str, revision: u32, id: u32) -> Result<String, String> {
        self.scope(generation, revision)?;
        self.node(id)?;
        #[derive(Serialize)]
        struct Detail<'a> {
            generation: &'a str,
            revision: u32,
            node: NodeSummary<'a>,
            path: String,
        }
        json(&Detail {
            generation: &self.generation,
            revision: self.revision,
            node: self.summary_node(id),
            path: self.path(id),
        })
    }
    pub fn prepare_delete(
        &self,
        generation: &str,
        revision: u32,
        id: u32,
    ) -> Result<DeletePlan, String> {
        self.scope(generation, revision)?;
        self.node(id)?;
        if id == 0 {
            return Err("Cannot delete the scan root directory.".into());
        }
        if !self.can_delete(id) {
            return Err("This scan entry cannot be deleted from the app.".into());
        }
        self.revision
            .checked_add(1)
            .ok_or("Scan revision limit reached; rescan first.")?;
        Ok(DeletePlan {
            generation: generation.into(),
            revision,
            node_id: id,
            path: self.path(id),
        })
    }
    fn commit_delete(&mut self, plan: &DeletePlan, message: &str) -> Result<String, String> {
        self.scope(&plan.generation, plan.revision)?;
        let node = self.node(plan.node_id)?;
        let (size, files, dirs, parent) = (node.size, node.files, node.directories, node.parent);
        let key = self.key(plan.node_id);
        if !self.children[parent as usize].remove(&key) {
            return Err("Scan deletion index is inconsistent".into());
        }
        self.response.nodes[plan.node_id as usize].deleted = true;
        let mut ancestor = parent;
        while ancestor != NONE {
            let key = self.key(ancestor);
            let node = &mut self.response.nodes[ancestor as usize];
            let parent = node.parent;
            node.size = node
                .size
                .checked_sub(size)
                .ok_or("Invalid scan size after deletion")?;
            node.files = node
                .files
                .checked_sub(files)
                .ok_or("Invalid scan file count after deletion")?;
            node.directories = node
                .directories
                .checked_sub(dirs)
                .ok_or("Invalid scan directory count after deletion")?;
            if parent != NONE {
                if !self.children[parent as usize].remove(&key) {
                    return Err("Scan deletion index is inconsistent".into());
                }
                let updated = self.key(ancestor);
                self.children[parent as usize].insert(updated);
            }
            ancestor = parent;
        }
        self.response.total_size = self.response.nodes[0].size;
        self.response.total_files = self.response.nodes[0].files;
        self.response.total_dirs = self.response.nodes[0].directories;
        self.revision += 1;
        #[derive(Serialize)]
        struct Deleted<'a> {
            summary: Summary<'a>,
            message: &'a str,
            removed: Removed,
        }
        #[derive(Serialize)]
        struct Removed {
            size: u64,
            files: u64,
            dirs: u64,
        }
        json(&Deleted {
            summary: self.summary(),
            message,
            removed: Removed { size, files, dirs },
        })
    }
}

/// Once DELETE is sent, any failure may mean a partially changed filesystem.
/// Quarantine the snapshot instead of offering stale IDs or retrying blindly.
pub fn finish_delete(
    store: &mut Option<Catalog>,
    plan: &DeletePlan,
    response: Result<String, String>,
) -> Result<String, String> {
    // A late result belongs only to its original snapshot. Never quarantine
    // a newer generation if a caller violated the operation-lock ordering.
    store
        .as_ref()
        .ok_or("Scan is unavailable; rescan required")?
        .scope(&plan.generation, plan.revision)?;
    let result = (|| {
        let raw = response?;
        let value: serde_json::Value =
            serde_json::from_str(&raw).map_err(|_| "Invalid deletion response")?;
        if value["status"] != "ok" {
            return Err(value["message"]
                .as_str()
                .unwrap_or("Deletion failed; rescan required")
                .to_string());
        }
        let message = value["message"]
            .as_str()
            .ok_or("Invalid deletion response")?;
        store
            .as_mut()
            .ok_or("Scan is unavailable; rescan required")?
            .commit_delete(plan, message)
    })();
    if result.is_err() {
        *store = None;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan_stream;
    use serde_json::{json, Value};
    use std::io::Cursor as Reader;

    fn frame(kind: &str, data: Value) -> Vec<u8> {
        let data = serde_json::to_vec(&json!({"type":kind,"data":data})).unwrap();
        let mut bytes = (data.len() as u32).to_be_bytes().to_vec();
        bytes.extend(data);
        bytes
    }
    fn entry(
        id: usize,
        parent: Option<usize>,
        name: &str,
        kind: &str,
        size: u64,
        counted: bool,
    ) -> Value {
        json!({"id":id,"parent":parent,"name":name,"kind":kind,"size":size,"counted":counted})
    }
    fn fixture(entries: &[Value], read_only: bool) -> Response {
        let mut bytes = frame(
            "started",
            json!({"stream_version":1,"root":"/fixture","read_only":read_only}),
        );
        for batch in entries.chunks(128) {
            bytes.extend(frame("entries", json!({"entries":batch})));
        }
        let files = entries
            .iter()
            .filter(|e| e["kind"] == "file" && e["counted"] == true)
            .count();
        let dirs = entries
            .iter()
            .filter(|e| e["kind"] == "directory" && e["counted"] == true)
            .count();
        let size: u64 = entries.iter().map(|e| e["size"].as_u64().unwrap()).sum();
        bytes.extend(frame("done", json!({"total_files":files,"total_dirs":dirs,"total_size":size,
            "errors":0,"skipped":0,"scan_time_ms":1,"scan_threads":1,"serialize_ms":0,"send_ms":0,"bytes_sent":bytes.len()})));
        scan_stream::read(&mut Reader::new(bytes), read_only, |_| Ok(())).unwrap()
    }
    fn root() -> Value {
        entry(0, None, "fixture", "directory", 0, true)
    }
    fn wide(count: usize) -> Vec<Value> {
        let mut entries = vec![root()];
        // Lots of size ties and reversed insertion order exercise cursor keys.
        for id in 1..=count {
            entries.push(entry(
                id,
                Some(0),
                &format!("file-{:05}", count - id),
                "file",
                (id % 7) as u64,
                true,
            ));
        }
        entries
    }
    fn value(raw: Result<String, String>) -> Value {
        serde_json::from_str(&raw.unwrap()).unwrap()
    }
    fn view(store: &Catalog, id: u32) -> Value {
        value(store.view_json("generation-a", store.revision, id, None))
    }
    fn success() -> Result<String, String> {
        Ok(r#"{"status":"ok","message":"Deleted fixture entry"}"#.into())
    }

    #[test]
    fn file_type_rules_preserve_filename_boundaries() {
        for (name, expected) in [
            ("photo.JPG", "images"),
            ("影像.heIC", "images"),
            ("movie.MP4", "videos"),
            ("song.FLAC", "audio"),
            ("report.PdF", "documents"),
            ("backup.tar.gz", "archives"),
            ("app.XAPK", "android_packages"),
            ("README", "no_extension"),
            (".nomedia", "no_extension"),
            (".apk", "no_extension"),
            ("trailing.", "no_extension"),
            (".config.JPG", "images"),
            ("photo.jpg ", "other"),
            ("name.İMG", "other"),
            ("script.ts", "other"),
            ("image.jpg.exe", "other"),
        ] {
            assert_eq!(
                serde_json::to_value(FileType::of(name)).unwrap(),
                expected,
                "{name}"
            );
        }
    }

    #[test]
    fn file_types_reconcile_counting_modes_zero_bytes_and_placeholders() {
        let entries = vec![
            root(),
            entry(1, Some(0), "folder.pdf", "directory", 0, true),
            entry(2, Some(1), "photo.JPG", "file", 5, true),
            entry(3, Some(1), "song.FLAC", "file", 0, true),
            entry(4, Some(0), ".nomedia", "file", 7, true),
            entry(5, Some(0), "unknown.abc", "file", 0, true),
            entry(6, Some(0), "uncounted.jpg", "file", 0, false),
            entry(7, Some(0), "special.zip", "other", 0, false),
            entry(8, Some(1), "movie.mp4", "file", 1, true),
            entry(9, Some(1), "notes.pdf", "file", 2, true),
            entry(10, Some(1), "backup.tar.gz", "file", 3, true),
            entry(11, Some(1), "app.APK", "file", 4, true),
        ];
        for read_only in [false, true] {
            let store = Catalog::new(fixture(&entries, read_only), "generation-a".into());
            let result = value(store.file_types_json("generation-a", 0));
            assert_eq!(result["total_files"], 8);
            assert_eq!(result["total_size"], 22);
            let categories = result["categories"].as_array().unwrap();
            assert_eq!(categories.len(), 8);
            for (kind, files, size) in [
                ("images", 1, 5),
                ("audio", 1, 0),
                ("videos", 1, 1),
                ("documents", 1, 2),
                ("archives", 1, 3),
                ("android_packages", 1, 4),
                ("no_extension", 1, 7),
                ("other", 1, 0),
            ] {
                let category = categories.iter().find(|c| c["kind"] == kind).unwrap();
                assert_eq!(category["files"], files);
                assert_eq!(category["size"], size);
            }
            assert_eq!(
                categories
                    .iter()
                    .map(|c| c["files"].as_u64().unwrap())
                    .sum::<u64>(),
                8
            );
            assert_eq!(
                categories
                    .iter()
                    .map(|c| c["size"].as_u64().unwrap())
                    .sum::<u64>(),
                22
            );
            assert!(!result.to_string().contains("photo.JPG"));
        }
        let empty = Catalog::new(fixture(&[root()], false), "generation-a".into());
        let result = value(empty.file_types_json("generation-a", 0));
        assert!(result["categories"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["files"] == 0 && c["size"] == 0));
        let mut inconsistent = fixture(&entries, false);
        inconsistent.total_size += 1;
        assert!(Catalog::new(inconsistent, "generation-a".into())
            .file_types_json("generation-a", 0)
            .is_err());
    }

    #[test]
    fn file_types_follow_deleted_subtrees_and_reject_stale_scopes() {
        let entries = vec![
            root(),
            entry(1, Some(0), "folder", "directory", 0, true),
            entry(2, Some(1), "large.jpg", "file", 99, true),
            entry(3, Some(0), "small.apk", "file", 1, true),
        ];
        let mut store = Some(Catalog::new(
            fixture(&entries, false),
            "generation-a".into(),
        ));
        assert!(store.as_ref().unwrap().file_types_json("old", 0).is_err());
        let plan = store
            .as_ref()
            .unwrap()
            .prepare_delete("generation-a", 0, 1)
            .unwrap();
        finish_delete(&mut store, &plan, success()).unwrap();
        let current = store.as_ref().unwrap();
        assert!(current.file_types_json("generation-a", 0).is_err());
        let result = value(current.file_types_json("generation-a", 1));
        assert_eq!(result["total_files"], 1);
        assert_eq!(result["total_size"], 1);
        assert_eq!(result["categories"][0]["files"], 0);
        assert_eq!(result["categories"][5]["files"], 1);
        let plan = current.prepare_delete("generation-a", 1, 3).unwrap();
        finish_delete(&mut store, &plan, success()).unwrap();
        let result = value(store.as_ref().unwrap().file_types_json("generation-a", 2));
        assert_eq!(result["total_files"], 0);
        assert_eq!(result["total_size"], 0);
    }

    #[test]
    fn file_types_response_is_bounded_independent_of_extension_cardinality() {
        let mut entries = vec![root()];
        for id in 1..=20_000 {
            entries.push(entry(id, Some(0), &format!("file.{id}"), "file", 1, true));
        }
        let store = Catalog::new(fixture(&entries, false), "generation-a".into());
        let output = store.file_types_json("generation-a", 0).unwrap();
        assert!(output.len() < 1024);
        let result = value(Ok(output));
        assert_eq!(result["categories"].as_array().unwrap().len(), 8);
        assert_eq!(result["categories"][7]["files"], 20_000);
        assert_eq!(result["categories"][7]["size"], 20_000);
    }

    #[test]
    fn largest_matches_exhaustive_sort_for_every_limit() {
        let mut entries = wide(1037);
        entries.push(entry(1038, Some(0), "nested", "directory", 0, true));
        // Same name and size in different directories exercises the ID tie.
        entries.push(entry(1039, Some(1038), "file-00001", "file", 0, true));
        entries.push(entry(1040, Some(1038), "not-counted", "file", 0, false));
        entries.push(entry(1041, Some(1038), "special", "other", 0, false));
        entries.push(entry(1042, Some(0), "aaa", "file", 6, true));
        entries.push(entry(1043, Some(1038), "aaa", "file", 6, true));
        let store = Catalog::new(fixture(&entries, false), "generation-a".into());
        let mut expected: Vec<_> = entries
            .iter()
            .filter(|e| e["kind"] == "file" && e["counted"] == true)
            .collect();
        expected.sort_by_key(|e| {
            (
                Reverse(e["size"].as_u64().unwrap()),
                e["name"].as_str().unwrap(),
                e["id"].as_u64().unwrap(),
            )
        });
        for limit in 1..=MAX_LARGEST_FILES {
            let result = value(store.largest_json("generation-a", 0, limit));
            let ids: Vec<_> = result["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|file| file["node"]["id"].clone())
                .collect();
            assert_eq!(
                ids,
                expected
                    .iter()
                    .take(limit)
                    .map(|e| e["id"].clone())
                    .collect::<Vec<_>>()
            );
            assert_eq!(result["total_files"], expected.len());
        }
        for limit in [0, MAX_LARGEST_FILES + 1, usize::MAX] {
            assert!(store.largest_json("generation-a", 0, limit).is_err());
        }
        assert!(store.largest_json("old", 0, 10).is_err());
        assert!(store.largest_json("generation-a", 1, 10).is_err());
    }

    #[test]
    fn largest_empty_zero_byte_exact_paths_and_read_only() {
        let empty = Catalog::new(fixture(&[root()], false), "generation-a".into());
        assert_eq!(
            value(empty.largest_json("generation-a", 0, 10))["files"],
            json!([])
        );
        let entries = vec![
            root(),
            entry(1, Some(0), " folder ", "directory", 0, true),
            entry(2, Some(1), " ü <>&\r\n ", "file", 0, true),
            entry(3, Some(0), "zero", "file", 0, true),
        ];
        for read_only in [false, true] {
            let store = Catalog::new(fixture(&entries, read_only), "generation-a".into());
            let files = value(store.largest_json("generation-a", 0, 100))["files"].clone();
            assert_eq!(files.as_array().unwrap().len(), 2);
            assert_eq!(files[0]["path"], "/fixture/ folder / ü <>&\r\n ");
            assert_eq!(files[0]["node"]["can_delete"], false);
            assert_eq!(files[1]["node"]["can_delete"], !read_only);
        }
    }

    #[test]
    fn largest_preserves_the_response_byte_limit_for_deep_paths() {
        let mut entries = vec![root()];
        for id in 1..=60 {
            entries.push(entry(
                id,
                Some(id - 1),
                &"d".repeat(250),
                "directory",
                0,
                true,
            ));
        }
        for id in 61..=160 {
            entries.push(entry(id, Some(60), &format!("file-{id}"), "file", 1, true));
        }
        let store = Catalog::new(fixture(&entries, false), "generation-a".into());
        assert!(store
            .largest_json("generation-a", 0, 100)
            .unwrap_err()
            .contains("Try a smaller file limit"));
        let small = store.largest_json("generation-a", 0, 10).unwrap();
        assert!(small.len() < MAX_QUERY_BYTES);
        assert_eq!(value(Ok(small))["files"].as_array().unwrap().len(), 10);
    }

    #[test]
    fn largest_tracks_deleted_subtrees_and_quarantines_missing_files() {
        let entries = vec![
            root(),
            entry(1, Some(0), "folder", "directory", 0, true),
            entry(2, Some(1), "large", "file", 99, true),
            entry(3, Some(0), "small", "file", 1, true),
        ];
        let mut store = Some(Catalog::new(
            fixture(&entries, false),
            "generation-a".into(),
        ));
        let plan = store
            .as_ref()
            .unwrap()
            .prepare_delete("generation-a", 0, 1)
            .unwrap();
        finish_delete(&mut store, &plan, success()).unwrap();
        let current = store.as_ref().unwrap();
        assert!(current.largest_json("generation-a", 0, 10).is_err());
        let result = value(current.largest_json("generation-a", 1, 10));
        assert_eq!(result["total_files"], 1);
        assert_eq!(result["files"].as_array().unwrap().len(), 1);
        assert_eq!(result["files"][0]["node"]["id"], 3);
        let plan = current.prepare_delete("generation-a", 1, 3).unwrap();
        assert!(finish_delete(
            &mut store,
            &plan,
            Ok(r#"{"status":"error","message":"File no longer exists"}"#.into())
        )
        .is_err());
        assert!(store.is_none());
    }

    #[test]
    fn complete_wide_paging_forward_backward_matches_legacy_order() {
        let response = fixture(&wide(1037), false);
        let legacy = value(response.json());
        let expected: Vec<_> = legacy["tree"]["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].clone())
            .collect();
        let store = Catalog::new(response, "generation-a".into());
        assert!(store.summary_json().unwrap().len() < 2048);
        let mut page = view(&store, 0);
        let mut all = Vec::new();
        let mut pages = Vec::new();
        loop {
            let names: Vec<_> = page["children"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["name"].clone())
                .collect();
            assert!(names.len() <= PAGE_SIZE);
            all.extend(names.clone());
            pages.push(names);
            if page["next_cursor"].is_null() {
                break;
            }
            page = value(store.view_json(
                "generation-a",
                0,
                0,
                Some(serde_json::from_value(page["next_cursor"].clone()).unwrap()),
            ));
        }
        assert_eq!(all, expected);
        for expected in pages.iter().rev().skip(1) {
            assert!(!page["previous_cursor"].is_null());
            page = value(store.view_json(
                "generation-a",
                0,
                0,
                Some(serde_json::from_value(page["previous_cursor"].clone()).unwrap()),
            ));
            let names: Vec<_> = page["children"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["name"].clone())
                .collect();
            assert_eq!(&names, expected);
        }
        assert!(page["previous_cursor"].is_null());
    }
    #[test]
    fn chart_has_exact_remainder_and_no_destructive_synthetic_id() {
        let store = Catalog::new(fixture(&wide(600), false), "generation-a".into());
        let page = view(&store, 0);
        let chart = page["chart"].as_array().unwrap();
        assert_eq!(chart.len(), CHART_SIZE + 1);
        assert_eq!(
            chart
                .iter()
                .map(|e| e["size"].as_u64().unwrap())
                .sum::<u64>(),
            page["node"]["size"].as_u64().unwrap()
        );
        assert_eq!(chart.last().unwrap()["name"], "Other");
        assert!(chart.last().unwrap()["node_id"].is_null());
        assert!(view(&store, 1)["chart"].as_array().unwrap().is_empty());
    }
    #[test]
    fn deep_paths_parents_totals_and_placeholders_match_legacy_tree() {
        let mut entries = vec![root()];
        for id in 1..32 {
            entries.push(entry(
                id,
                Some(id - 1),
                &format!(" 写真 {id}"),
                "directory",
                0,
                true,
            ));
        }
        entries.push(entry(32, Some(31), " leaf ", "file", 13, true));
        entries.push(entry(33, Some(0), "fifo", "other", 0, false));
        let response = fixture(&entries, false);
        let legacy = value(response.json());
        let store = Catalog::new(response, "generation-a".into());
        let mut expected = &legacy["tree"];
        for id in 0..=32 {
            let page = view(&store, id);
            assert_eq!(page["path"], expected["path"]);
            assert_eq!(page["node"]["size"], expected["size"]);
            assert_eq!(page["node"]["name"], expected["name"]);
            assert_eq!(
                page["node"]["parent_id"],
                if id == 0 { Value::Null } else { json!(id - 1) }
            );
            assert_eq!(
                page["breadcrumbs"].as_array().unwrap().len(),
                id as usize + 1
            );
            if id < 32 {
                expected = &expected["children"][0];
            }
        }
        assert!(!view(&store, 33)["node"]["counted"].as_bool().unwrap());
        assert_eq!(store.response.nodes[0].files, 1);
        assert_eq!(store.response.nodes[0].directories, 32);
    }
    #[test]
    fn maximum_depth_and_paths_stay_exact_without_recursive_ipc() {
        let mut entries = vec![root()];
        let mut expected = "/fixture".to_string();
        for id in 1..=64 {
            let length = if id == 64 { 247 } else { 255 };
            let name = "x".repeat(length);
            expected.push('/');
            expected.push_str(&name);
            entries.push(entry(
                id,
                Some(id - 1),
                &name,
                if id == 64 { "file" } else { "directory" },
                if id == 64 { 1 } else { 0 },
                true,
            ));
        }
        assert_eq!(expected.len(), 16 * 1024);
        let store = Catalog::new(fixture(&entries, false), "generation-a".into());
        let page = view(&store, 64);
        assert_eq!(page["path"], expected);
        assert_eq!(page["breadcrumbs"].as_array().unwrap().len(), 65);
        assert!(store.prepare_delete("generation-a", 0, 64).is_err());
        assert_eq!(page["node"]["can_delete"], false);
        assert_eq!(store.response.total_dirs, 64);
    }
    #[test]
    fn bridge_queries_and_deletion_reject_invalidated_or_reconnected_snapshots() {
        let _operation = crate::DAEMON_OPERATION.lock().unwrap();
        *crate::SCAN_STORE.lock().unwrap() = Some(Catalog::new(
            fixture(&wide(2), false),
            "generation-a".into(),
        ));
        assert!(crate::get_scan_view("generation-a".into(), 0, 0, None).is_ok());
        assert!(crate::get_scan_node("generation-a".into(), 0, 1).is_ok());
        crate::invalidate_scan().unwrap();
        assert!(crate::get_scan_view("generation-a".into(), 0, 0, None).is_err());
        assert!(crate::get_scan_node("generation-a".into(), 0, 1).is_err());
        *crate::SCAN_STORE.lock().unwrap() = Some(Catalog::new(
            fixture(&wide(2), false),
            "generation-b".into(),
        ));
        assert!(crate::get_scan_view("generation-a".into(), 0, 0, None).is_err());
        assert!(crate::get_scan_node("generation-a".into(), 0, 1).is_err());
        let guard = crate::SCAN_STORE.lock().unwrap();
        assert!(guard
            .as_ref()
            .unwrap()
            .prepare_delete("generation-a", 0, 1)
            .is_err());
        drop(guard);
        crate::invalidate_scan().unwrap();
    }
    #[test]
    fn exact_names_are_preserved_and_unrepresentable_deletes_are_blocked() {
        let entries = vec![
            root(),
            entry(1, Some(0), " 写真 \" $() ", "directory", 0, true),
            entry(2, Some(1), "ok", "file", 7, true),
            entry(3, Some(0), "line\nbreak", "directory", 0, true),
            entry(4, Some(3), "child", "file", 2, true),
        ];
        let store = Catalog::new(fixture(&entries, false), "generation-a".into());
        let plan = store.prepare_delete("generation-a", 0, 2).unwrap();
        assert_eq!(plan.path, "/fixture/ 写真 \" $() /ok");
        assert_eq!(
            value(store.detail_json("generation-a", 0, 2))["path"],
            plan.path
        );
        assert!(store.prepare_delete("generation-a", 0, 0).is_err());
        for id in [3, 4] {
            assert!(store.prepare_delete("generation-a", 0, id).is_err());
            assert_eq!(view(&store, id)["node"]["can_delete"], false);
        }
        let readonly = Catalog::new(fixture(&entries, true), "generation-a".into());
        assert!(readonly.prepare_delete("generation-a", 0, 2).is_err());
        assert_eq!(view(&readonly, 2)["node"]["can_delete"], false);
    }
    #[test]
    fn delete_updates_ancestors_order_and_invalidates_descendants_and_cursors() {
        let entries = vec![
            root(),
            entry(1, Some(0), "folder", "directory", 0, true),
            entry(2, Some(1), "sub", "directory", 0, true),
            entry(3, Some(2), "large", "file", 70, true),
            entry(4, Some(1), "small", "file", 10, true),
            entry(5, Some(0), "other", "file", 40, true),
        ];
        let mut store = Some(Catalog::new(
            fixture(&entries, false),
            "generation-a".into(),
        ));
        let plan = store
            .as_ref()
            .unwrap()
            .prepare_delete("generation-a", 0, 2)
            .unwrap();
        let result = value(finish_delete(&mut store, &plan, success()));
        assert_eq!(result["removed"], json!({"size":70,"files":1,"dirs":1}));
        assert_eq!(result["summary"]["total_size"], 50);
        assert_eq!(result["summary"]["total_files"], 2);
        assert_eq!(result["summary"]["total_dirs"], 2);
        let current = store.as_ref().unwrap();
        assert_eq!(view(current, 0)["children"][0]["id"], 5);
        assert_eq!(view(current, 1)["node"]["size"], 10);
        for id in [2, 3] {
            assert!(current.view_json("generation-a", 1, id, None).is_err());
            assert!(current.prepare_delete("generation-a", 1, id).is_err());
        }
        assert!(current.view_json("generation-a", 0, 0, None).is_err());
        assert!(current
            .view_json(
                "generation-a",
                0,
                0,
                Some(Cursor {
                    direction: Direction::Next,
                    node_id: 1
                })
            )
            .is_err());
        let plan = current.prepare_delete("generation-a", 1, 1).unwrap();
        let result = value(finish_delete(&mut store, &plan, success()));
        assert_eq!(result["summary"]["total_dirs"], 1);
        assert_eq!(result["summary"]["total_files"], 1);
        assert_eq!(result["summary"]["total_size"], 40);
    }
    #[test]
    fn repeated_file_and_directory_deletes_match_recursive_reference_totals() {
        fn remove(tree: &mut Value, path: &str) -> bool {
            let Some(children) = tree.get_mut("children").and_then(Value::as_array_mut) else {
                return false;
            };
            if let Some(index) = children.iter().position(|node| node["path"] == path) {
                children.remove(index);
                return true;
            }
            children.iter_mut().any(|child| remove(child, path))
        }
        fn totals(tree: &mut Value) -> (u64, u64, u64) {
            if tree["type"] == "file" {
                return (
                    tree["size"].as_u64().unwrap(),
                    u64::from(tree["counted"] != false),
                    0,
                );
            }
            let mut result = (0, 0, u64::from(tree["counted"] != false));
            for child in tree["children"].as_array_mut().unwrap() {
                let (size, files, dirs) = totals(child);
                result.0 += size;
                result.1 += files;
                result.2 += dirs;
            }
            tree["size"] = json!(result.0);
            result
        }
        let mut entries = vec![root()];
        for id in 1..=10 {
            entries.push(entry(
                id,
                Some(0),
                &format!("dir-{id}"),
                "directory",
                0,
                true,
            ));
        }
        for id in 11..=610 {
            entries.push(entry(
                id,
                Some(id % 10 + 1),
                &format!("file-{id}"),
                "file",
                (id * 71 % 1000) as u64,
                true,
            ));
        }
        let response = fixture(&entries, false);
        let mut reference = value(response.json())["tree"].take();
        let mut store = Some(Catalog::new(response, "generation-a".into()));
        for id in [1, 47, 123, 304, 2, 457, 602, 3, 9, 10] {
            let current = store.as_ref().unwrap();
            let plan = current
                .prepare_delete("generation-a", current.revision, id)
                .unwrap();
            assert!(remove(&mut reference, &plan.path));
            let expected = totals(&mut reference);
            let result = value(finish_delete(&mut store, &plan, success()));
            assert_eq!(result["summary"]["total_size"], expected.0);
            assert_eq!(result["summary"]["total_files"], expected.1);
            assert_eq!(result["summary"]["total_dirs"], expected.2);
        }
    }
    #[test]
    fn generation_replacement_invalidates_all_old_queries_and_delete_plans() {
        let entries = wide(3);
        let old = Catalog::new(fixture(&entries, false), "generation-a".into());
        let plan = old.prepare_delete("generation-a", 0, 1).unwrap();
        let new = Catalog::new(fixture(&entries, false), "generation-b".into());
        assert!(new.view_json("generation-a", 0, 0, None).is_err());
        assert!(new.detail_json("generation-a", 0, 1).is_err());
        assert!(new.prepare_delete("generation-a", 0, 1).is_err());
        let mut store = Some(new);
        assert!(finish_delete(&mut store, &plan, success()).is_err());
        assert_eq!(store.as_ref().unwrap().generation, "generation-b");
    }
    #[test]
    fn invalid_nodes_and_wrong_parent_or_empty_page_cursors_fail() {
        let entries = vec![
            root(),
            entry(1, Some(0), "folder", "directory", 0, true),
            entry(2, Some(1), "file", "file", 1, true),
        ];
        let store = Catalog::new(fixture(&entries, false), "generation-a".into());
        assert!(store.view_json("generation-a", 0, u32::MAX, None).is_err());
        assert!(store
            .view_json(
                "generation-a",
                0,
                0,
                Some(Cursor {
                    direction: Direction::Next,
                    node_id: 2
                })
            )
            .is_err());
        assert!(store
            .view_json(
                "generation-a",
                0,
                0,
                Some(Cursor {
                    direction: Direction::Next,
                    node_id: 1
                })
            )
            .is_err());
        assert!(store
            .view_json(
                "generation-a",
                0,
                0,
                Some(Cursor {
                    direction: Direction::Previous,
                    node_id: 1
                })
            )
            .is_err());
        assert!(serde_json::from_value::<Cursor>(
            json!({"direction":"next","node_id":1,"extra":1})
        )
        .is_err());
        assert!(
            serde_json::from_value::<Cursor>(json!({"direction":"offset","node_id":1})).is_err()
        );
    }
    #[test]
    fn transport_partial_and_malformed_delete_failures_quarantine_snapshot() {
        for response in [
            Err("connection lost".into()),
            Ok(r#"{"status":"error","message":"partially deleted directory"}"#.into()),
            Ok("truncated".into()),
            Ok(r#"{"status":"ok"}"#.into()),
        ] {
            let mut store = Some(Catalog::new(
                fixture(&wide(2), false),
                "generation-a".into(),
            ));
            let plan = store
                .as_ref()
                .unwrap()
                .prepare_delete("generation-a", 0, 1)
                .unwrap();
            assert!(finish_delete(&mut store, &plan, response).is_err());
            assert!(store.is_none());
        }
    }
    #[test]
    fn concurrent_reads_and_revision_commit_return_consistent_snapshots() {
        use std::sync::{Barrier, Mutex};
        let store = Arc::new(Mutex::new(Some(Catalog::new(
            fixture(&wide(300), false),
            "generation-a".into(),
        ))));
        let barrier = Arc::new(Barrier::new(5));
        std::thread::scope(|threads| {
            for _ in 0..4 {
                let store = store.clone();
                let barrier = barrier.clone();
                threads.spawn(move || {
                    barrier.wait();
                    for _ in 0..40 {
                        let guard = store.lock().unwrap();
                        let result = guard
                            .as_ref()
                            .unwrap()
                            .view_json("generation-a", 0, 0, None);
                        if let Ok(raw) = result {
                            let page: Value = serde_json::from_str(&raw).unwrap();
                            assert_eq!(page["revision"], 0);
                            assert_eq!(page["node"]["child_count"], 300);
                        } else {
                            assert_eq!(guard.as_ref().unwrap().revision, 1);
                        }
                    }
                });
            }
            barrier.wait();
            let mut guard = store.lock().unwrap();
            let plan = guard
                .as_ref()
                .unwrap()
                .prepare_delete("generation-a", 0, 1)
                .unwrap();
            finish_delete(&mut guard, &plan, success()).unwrap();
        });
        assert_eq!(
            view(store.lock().unwrap().as_ref().unwrap(), 0)["node"]["child_count"],
            299
        );
    }
    #[test]
    fn stop_releases_local_authority_on_success_and_unconfirmed_failures() {
        let _operation = crate::DAEMON_OPERATION.lock().unwrap();
        for outcome in [
            Ok(r#"{"status":"ok","message":"shutting down"}"#.into()),
            Err("Phone disconnected".into()),
            Err("Bundled ADB unavailable".into()),
        ] {
            let expected = outcome.clone();
            *crate::SCAN_STORE.lock().unwrap() =
                Some(Catalog::new(fixture(&wide(2), true), "generation-a".into()));
            *crate::SESSION.lock().unwrap() = Some(crate::session::Session::test_session());
            assert!(crate::active_connection().unwrap().read_only);
            assert_eq!(crate::finish_stop(outcome), expected);
            assert!(crate::SCAN_STORE.lock().unwrap().is_none());
            assert!(crate::SESSION.lock().unwrap().is_none());
            assert!(crate::active_connection().is_err());
            assert!(crate::get_scan_view("generation-a".into(), 0, 0, None).is_err());
        }
    }
    #[test]
    fn response_writer_is_bounded_even_when_serialization_escapes_expand() {
        assert!(json(&"\u{0001}".repeat(MAX_QUERY_BYTES / 6 + 1)).is_err());
        let store = Catalog::new(fixture(&wide(1000), false), "generation-a".into());
        assert!(store.view_json("generation-a", 0, 0, None).unwrap().len() < MAX_QUERY_BYTES);
    }
}
