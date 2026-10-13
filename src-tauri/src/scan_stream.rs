//! Bounded stream-v1 decoder. Verified records transfer to the host scan store.
#[cfg(test)]
use serde::ser::{SerializeSeq, SerializeStruct};
use serde::{Deserialize, Serialize};
use std::io::Read;
#[cfg(test)]
use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_FRAME_BYTES: usize = 128 * 1024;
const MAX_BATCH_ENTRIES: usize = 128;
const MAX_NODES: usize = 2_000_000;
const MAX_TREE_BYTES: usize = 128 * 1024 * 1024;
#[cfg(test)]
const MAX_RESULT_BYTES: usize = 256 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = (1u64 << 53) - 1;
pub(crate) const NONE: u32 = u32::MAX;

#[derive(Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum Frame {
    Started {
        stream_version: u32,
        root: String,
        read_only: bool,
    },
    Entries {
        entries: Vec<Entry>,
    },
    Done {
        total_files: u64,
        total_dirs: u64,
        total_size: u64,
        errors: u64,
        skipped: u64,
        scan_time_ms: u64,
        scan_threads: u32,
        serialize_ms: u64,
        send_ms: u64,
        bytes_sent: u64,
    },
    Error {
        message: String,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: usize,
    parent: Option<usize>,
    name: String,
    kind: Kind,
    size: u64,
    counted: bool,
}
#[derive(Deserialize, PartialEq, Copy, Clone)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Kind {
    File,
    Directory,
    Other,
}
pub(crate) struct Node {
    pub name: Arc<str>,
    pub size: u64,
    pub parent: u32,
    first_child: u32,
    next_sibling: u32,
    path_bytes: u32,
    depth: u8,
    pub kind: Kind,
    pub counted: bool,
    pub files: u64,
    pub directories: u64,
    pub deleted: bool,
}
// Serialize directly from compact records. Full paths and recursive child
// objects are never materialized in a second host tree.
#[cfg(test)]
struct NodeView<'a> {
    nodes: &'a [Node],
    index: u32,
    path: &'a str,
}
#[cfg(test)]
impl Serialize for NodeView<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let node = &self.nodes[self.index as usize];
        let directory = node.kind == Kind::Directory;
        let fields = 4 + usize::from(directory) + usize::from(!node.counted);
        let mut result = serializer.serialize_struct("Node", fields)?;
        result.serialize_field("name", node.name.as_ref())?;
        result.serialize_field("path", &self.path)?;
        result.serialize_field("type", if directory { "directory" } else { "file" })?;
        result.serialize_field("size", &node.size)?;
        // Ordinary nodes keep the existing frontend shape. Only placeholders
        // need an extra field to preserve deletion/counting semantics.
        if !node.counted {
            result.serialize_field("counted", &false)?;
        }
        if directory {
            result.serialize_field(
                "children",
                &ChildrenView {
                    nodes: self.nodes,
                    first: node.first_child,
                    path: self.path,
                },
            )?;
        }
        result.end()
    }
}
#[cfg(test)]
struct ChildrenView<'a> {
    nodes: &'a [Node],
    first: u32,
    path: &'a str,
}
#[cfg(test)]
impl Serialize for ChildrenView<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(None)?;
        let mut index = self.first;
        while index != NONE {
            let node = &self.nodes[index as usize];
            let path = format!(
                "{}{}{}",
                self.path,
                if self.path == "/" { "" } else { "/" },
                node.name
            );
            sequence.serialize_element(&NodeView {
                nodes: self.nodes,
                index,
                path: &path,
            })?;
            index = node.next_sibling;
        }
        sequence.end()
    }
}
#[derive(Clone, Serialize, Default)]
pub struct Progress {
    pub files: u64,
    pub directories: u64,
    pub total_size: u64,
    pub recent_names: Vec<String>,
}
#[derive(Serialize)]
pub struct Response {
    #[serde(skip)]
    pub(crate) nodes: Vec<Node>,
    #[serde(skip)]
    pub(crate) root: String,
    status: &'static str,
    pub(crate) total_files: u64,
    pub(crate) total_dirs: u64,
    pub(crate) total_size: u64,
    errors: u64,
    skipped: u64,
    pub(crate) read_only: bool,
    scan_time_ms: u64,
    scan_threads: u32,
    streamed: bool,
    traverse_ms: u64,
    pub(crate) sort_ms: u64,
    serialize_ms: u64,
    send_ms: u64,
    bytes_sent: u64,
}
impl Response {
    pub fn root(&self) -> &str {
        &self.root
    }
    #[cfg(test)]
    pub fn json(&self) -> Result<String, String> {
        struct Limited(Vec<u8>);
        impl Write for Limited {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if bytes.len() > MAX_RESULT_BYTES.saturating_sub(self.0.len()) {
                    return Err(std::io::Error::other(
                        "Scan exceeds the current UI result limit",
                    ));
                }
                self.0.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        #[derive(Serialize)]
        struct View<'a> {
            #[serde(flatten)]
            response: &'a Response,
            tree: NodeView<'a>,
        }
        let mut output = Limited(Vec::new());
        serde_json::to_writer(
            &mut output,
            &View {
                response: self,
                tree: NodeView {
                    nodes: &self.nodes,
                    index: 0,
                    path: &self.root,
                },
            },
        )
        .map_err(|e| format!("Cannot display scan: {e}"))?;
        String::from_utf8(output.0).map_err(|_| "Invalid scan encoding".into())
    }
}
pub trait StreamReader: Read {
    fn begin_frame(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<T: AsRef<[u8]>> StreamReader for std::io::Cursor<T> {}
// Socket timeouts reset after every short read. Enforce an absolute deadline
// for each complete frame too, including its length prefix.
pub struct SocketReader<'a> {
    socket: &'a mut std::net::TcpStream,
    deadline: Instant,
}
impl<'a> SocketReader<'a> {
    pub fn new(socket: &'a mut std::net::TcpStream) -> Self {
        Self {
            socket,
            deadline: Instant::now() + super::TCP_READ_TIMEOUT,
        }
    }
}
impl StreamReader for SocketReader<'_> {
    fn begin_frame(&mut self) -> std::io::Result<()> {
        self.deadline = Instant::now() + super::TCP_READ_TIMEOUT;
        Ok(())
    }
}
impl Read for SocketReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::TimedOut, "Scan frame deadline exceeded")
            })?;
        self.socket.set_read_timeout(Some(remaining))?;
        self.socket.read(bytes)
    }
}
fn frame(reader: &mut impl StreamReader) -> Result<(Frame, usize), String> {
    reader.begin_frame().map_err(|e| e.to_string())?;
    let mut header = [0u8; 4];
    reader
        .read_exact(&mut header)
        .map_err(|e| format!("Incomplete scan frame header: {e}"))?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err("Invalid scan frame size".into());
    }
    let mut bytes = vec![0u8; length];
    reader
        .read_exact(&mut bytes)
        .map_err(|e| format!("Incomplete scan frame payload: {e}"))?;
    let value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Invalid scan frame (filenames must be valid UTF-8): {e}"))?;
    Ok((value, length + 4))
}
fn safe_add(a: u64, b: u64) -> Result<u64, String> {
    a.checked_add(b)
        .filter(|v| *v <= MAX_SAFE_INTEGER)
        .ok_or_else(|| "Scan total exceeds the UI's exact integer range".into())
}

pub fn read(
    reader: &mut impl StreamReader,
    expected_read_only: bool,
    mut progress: impl FnMut(&Progress) -> Result<(), String>,
) -> Result<Response, String> {
    let (first, mut bytes_received) = frame(reader)?;
    let root = match first {
        Frame::Error { message } => return Err(message),
        Frame::Started {
            stream_version: 1,
            root,
            read_only,
        } if read_only == expected_read_only => root,
        _ => return Err("Invalid scan start or access-mode negotiation".into()),
    };
    if !root.starts_with('/')
        || root.contains('\0')
        || root.len() > 16 * 1024
        || (root.len() > 1 && root.ends_with('/'))
    {
        return Err("Invalid scan root".into());
    }
    let root_name = if root == "/" {
        "/"
    } else {
        root.rsplit('/').next().unwrap()
    };
    let mut nodes: Vec<Node> = Vec::new();
    let mut tree_bytes = 0usize;
    let mut observed = Progress::default();
    let mut last_progress = Instant::now();
    let mut first_results_sent = false;
    progress(&observed)?;
    loop {
        let (item, byte_count) = frame(reader)?;
        match item {
            Frame::Error { message } => return Err(message),
            Frame::Started { .. } => return Err("Duplicate scan start".into()),
            Frame::Entries { entries } => {
                if entries.is_empty() || entries.len() > MAX_BATCH_ENTRIES {
                    return Err("Invalid scan batch size".into());
                }
                for entry in entries {
                    if entry.id != nodes.len()
                        || nodes.len() >= MAX_NODES
                        || entry.size > MAX_SAFE_INTEGER
                        || (entry.kind != Kind::File && entry.size != 0)
                        || (!entry.counted && entry.size != 0)
                        || (entry.kind == Kind::Other && entry.counted)
                    {
                        return Err(
                            "Invalid scan entry or scan exceeds the current entry limit".into()
                        );
                    }
                    let (path_bytes, depth, next_sibling) = if let Some(parent_id) = entry.parent {
                        let parent = nodes
                            .get(parent_id)
                            .ok_or("Scan child precedes its parent")?;
                        if parent.kind != Kind::Directory
                            || !parent.counted
                            || entry.name.is_empty()
                            || entry.name == "."
                            || entry.name == ".."
                            || entry.name.contains(['/', '\0'])
                            || entry.name.len() > 255
                        {
                            return Err("Invalid scan parent or filename".into());
                        }
                        (
                            parent.path_bytes as usize
                                + usize::from(!(parent_id == 0 && root == "/"))
                                + entry.name.len(),
                            parent.depth as usize + 1,
                            parent.first_child,
                        )
                    } else {
                        if !nodes.is_empty()
                            || entry.kind != Kind::Directory
                            || !entry.counted
                            || entry.name != root_name
                        {
                            return Err("Invalid scan root entry".into());
                        }
                        (root.len(), 0, NONE)
                    };
                    if path_bytes > 16 * 1024 || depth > 64 {
                        return Err("Scan path/depth limit exceeded".into());
                    }
                    // Conservative budget covers records, shared names, directory
                    // indexes, and decoder staging; full paths stay transient.
                    tree_bytes = tree_bytes
                        .checked_add(path_bytes + entry.name.len() + 256)
                        .ok_or("Scan memory limit exceeded")?;
                    if tree_bytes > MAX_TREE_BYTES {
                        return Err("Scan exceeds the current UI memory limit".into());
                    }
                    if entry.counted {
                        if entry.kind == Kind::Directory {
                            observed.directories = safe_add(observed.directories, 1)?;
                        } else {
                            observed.files = safe_add(observed.files, 1)?;
                            observed.total_size = safe_add(observed.total_size, entry.size)?;
                        }
                    }
                    if let Some(parent) = entry.parent {
                        nodes[parent].first_child = entry.id as u32;
                    }
                    nodes.push(Node {
                        name: entry.name.into(),
                        size: entry.size,
                        parent: entry.parent.map_or(NONE, |id| id as u32),
                        first_child: NONE,
                        next_sibling,
                        path_bytes: path_bytes as u32,
                        depth: depth as u8,
                        kind: entry.kind,
                        counted: entry.counted,
                        files: u64::from(entry.counted && entry.kind == Kind::File),
                        directories: u64::from(entry.counted && entry.kind == Kind::Directory),
                        deleted: false,
                    });
                }
                if (!first_results_sent && nodes.len() > 1)
                    || last_progress.elapsed() >= Duration::from_millis(100)
                {
                    observed.recent_names = nodes
                        .iter()
                        .skip(1)
                        .rev()
                        .take(5)
                        .map(|node| node.name.to_string())
                        .collect();
                    observed.recent_names.reverse();
                    progress(&observed)?;
                    first_results_sent = true;
                    last_progress = Instant::now();
                }
            }
            Frame::Done {
                total_files,
                total_dirs,
                total_size,
                errors,
                skipped,
                scan_time_ms,
                scan_threads,
                serialize_ms,
                send_ms,
                bytes_sent,
            } => {
                if nodes.is_empty()
                    || total_files != observed.files
                    || total_dirs != observed.directories
                    || total_size != observed.total_size
                    || bytes_sent != bytes_received as u64
                    || !(1..=8).contains(&scan_threads)
                    || (expected_read_only && scan_threads != 1)
                    || [
                        errors,
                        skipped,
                        scan_time_ms,
                        serialize_ms,
                        send_ms,
                        bytes_sent,
                    ]
                    .iter()
                    .any(|v| *v > MAX_SAFE_INTEGER)
                {
                    return Err(
                        "Scan completion does not match received entries or negotiated mode".into(),
                    );
                }
                let mut trailing = [0];
                if reader
                    .read(&mut trailing)
                    .map_err(|e| format!("Scan did not close after completion: {e}"))?
                    != 0
                {
                    return Err("Unexpected data after scan completion".into());
                }
                let sort_start = Instant::now();
                for index in (1..nodes.len()).rev() {
                    let parent = nodes[index].parent as usize;
                    nodes[parent].size = safe_add(nodes[parent].size, nodes[index].size)?;
                    nodes[parent].files = safe_add(nodes[parent].files, nodes[index].files)?;
                    nodes[parent].directories =
                        safe_add(nodes[parent].directories, nodes[index].directories)?;
                }
                if nodes[0].size != total_size {
                    return Err("Scan tree does not match completion totals".into());
                }
                let mut children = Vec::new();
                for parent in 0..nodes.len() {
                    children.clear();
                    let mut child = nodes[parent].first_child;
                    while child != NONE {
                        children.push(child);
                        child = nodes[child as usize].next_sibling;
                    }
                    children.sort_unstable_by(|a, b| {
                        nodes[*a as usize].name.cmp(&nodes[*b as usize].name)
                    });
                    if children
                        .windows(2)
                        .any(|pair| nodes[pair[0] as usize].name == nodes[pair[1] as usize].name)
                    {
                        return Err("Duplicate filename in scan directory".into());
                    }
                    children.sort_unstable_by(|a, b| {
                        nodes[*b as usize]
                            .size
                            .cmp(&nodes[*a as usize].size)
                            .then(nodes[*a as usize].name.cmp(&nodes[*b as usize].name))
                    });
                    for (index, child) in children.iter().enumerate() {
                        nodes[*child as usize].next_sibling =
                            children.get(index + 1).copied().unwrap_or(NONE);
                    }
                    nodes[parent].first_child = children.first().copied().unwrap_or(NONE);
                }
                observed.recent_names = nodes
                    .iter()
                    .skip(1)
                    .rev()
                    .take(5)
                    .map(|node| node.name.to_string())
                    .collect();
                observed.recent_names.reverse();
                progress(&observed)?;
                return Ok(Response {
                    status: "ok",
                    nodes,
                    root,
                    total_files,
                    total_dirs,
                    total_size,
                    errors,
                    skipped,
                    read_only: expected_read_only,
                    scan_time_ms,
                    scan_threads,
                    streamed: true,
                    traverse_ms: scan_time_ms,
                    sort_ms: sort_start.elapsed().as_millis() as u64,
                    serialize_ms,
                    send_ms,
                    bytes_sent,
                });
            }
        }
        bytes_received = bytes_received
            .checked_add(byte_count)
            .ok_or("Scan byte counter overflow")?;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::io::Cursor;
    fn encode(value: &Value) -> Vec<u8> {
        let mut fields = value.as_object().unwrap().clone();
        let kind = fields.remove("type").unwrap();
        let data = serde_json::to_vec(&json!({"type":kind,"data":fields})).unwrap();
        let mut bytes = (data.len() as u32).to_be_bytes().to_vec();
        bytes.extend(data);
        bytes
    }
    fn start() -> Value {
        json!({"type":"started","stream_version":1,"root":"/fixture","read_only":false})
    }
    fn root() -> Value {
        json!({"id":0,"parent":null,"name":"fixture","kind":"directory","size":0,"counted":true})
    }
    fn file() -> Value {
        json!({"id":1,"parent":0,"name":"file","kind":"file","size":7,"counted":true})
    }
    fn stream(entries: Vec<Value>, changes: Value) -> Vec<u8> {
        let mut bytes = encode(&start());
        bytes.extend(encode(&json!({"type":"entries","entries":entries})));
        let mut done = json!({"type":"done","total_files":1,"total_dirs":1,"total_size":7,
            "errors":0,"skipped":0,"scan_time_ms":1,"scan_threads":4,"serialize_ms":0,"send_ms":0,"bytes_sent":bytes.len()});
        for (key, value) in changes.as_object().unwrap() {
            done[key] = value.clone();
        }
        bytes.extend(encode(&done));
        bytes
    }
    fn parse(bytes: Vec<u8>) -> Result<Response, String> {
        read(&mut Cursor::new(bytes), false, |_| Ok(()))
    }
    #[test]
    fn reconstructs_exact_paths_counts_sorted_sizes_and_progress() {
        let entries = vec![
            root(),
            json!({"id":1,"parent":0,"name":"empty","kind":"directory","size":0,"counted":true}),
            json!({"id":2,"parent":1,"name":" 写真\n\" ","kind":"file","size":7,"counted":true}),
            json!({"id":3,"parent":0,"name":"fifo","kind":"other","size":0,"counted":false}),
        ];
        let mut snapshots = Vec::new();
        let result = read(
            &mut Cursor::new(stream(
                entries,
                json!({"total_dirs":2,"errors":3,"skipped":4}),
            )),
            false,
            |p| {
                snapshots.push(p.clone());
                Ok(())
            },
        )
        .unwrap();
        let value: Value = serde_json::from_str(&result.json().unwrap()).unwrap();
        assert_eq!(value["tree"]["size"], 7);
        assert_eq!(
            value["tree"]["children"][0]["children"][0]["path"],
            "/fixture/empty/ 写真\n\" "
        );
        assert_eq!(value["tree"]["children"][1]["counted"], false);
        assert_eq!(value["errors"], 3);
        assert_eq!(value["skipped"], 4);
        assert_eq!(snapshots.first().unwrap().files, 0);
        assert_eq!(snapshots.last().unwrap().files, 1);
        assert!(snapshots.len() >= 3);
    }
    #[test]
    fn rejects_every_truncation_and_requires_terminal_eof() {
        let bytes = stream(vec![root(), file()], json!({}));
        for length in 0..bytes.len() {
            assert!(parse(bytes[..length].to_vec()).is_err(), "length {length}");
        }
        assert!(parse(bytes.clone()).is_ok());
        for suffix in [
            vec![0],
            encode(&json!({"type":"error","message":"late"})),
            bytes.clone(),
        ] {
            let mut extra = bytes.clone();
            extra.extend(suffix);
            assert!(parse(extra).is_err());
        }
    }
    #[test]
    fn rejects_zero_oversized_and_malformed_frames_without_unbounded_reads() {
        for size in [0u32, MAX_FRAME_BYTES as u32 + 1, u32::MAX] {
            assert!(parse(size.to_be_bytes().to_vec()).is_err());
        }
        assert!(parse(encode(&json!({"type":"unknown"}))).is_err());
        let mut unknown_field = start();
        unknown_field["unexpected"] = json!(true);
        assert!(parse(encode(&unknown_field)).is_err());
        let mut bytes = encode(&start());
        bytes.extend(encode(&start()));
        assert!(parse(bytes).is_err());
        let mut bytes = encode(&start());
        bytes.extend(encode(&json!({"type":"entries","entries":[]})));
        assert!(parse(bytes).is_err());
        let entries = vec![root(); MAX_BATCH_ENTRIES + 1];
        assert!(parse(stream(entries, json!({}))).is_err());
        let mut invalid_utf8 = encode(&start());
        invalid_utf8.extend([0, 0, 0, 3, b'"', 255, b'"']);
        assert!(parse(invalid_utf8).is_err());
    }
    #[test]
    fn rejects_invalid_identifiers_parents_names_sizes_and_duplicates() {
        for changes in [
            json!({"id":0}),
            json!({"id":3}),
            json!({"parent":1}),
            json!({"parent":99}),
            json!({"parent":null}),
            json!({"name":""}),
            json!({"name":".."}),
            json!({"name":"a/b"}),
            json!({"name":"a\u{0}b"}),
            json!({"name":"x".repeat(256)}),
            json!({"size":-1}),
            json!({"size":MAX_SAFE_INTEGER + 1}),
            json!({"kind":"other"}),
            json!({"counted":false}),
        ] {
            let mut bad = file();
            for (key, value) in changes.as_object().unwrap() {
                bad[key] = value.clone();
            }
            assert!(
                parse(stream(vec![root(), bad], json!({}))).is_err(),
                "{changes}"
            );
        }
        let mut duplicate = file();
        duplicate["id"] = json!(2);
        assert!(parse(stream(
            vec![root(), file(), duplicate],
            json!({"total_files":2,"total_size":14})
        ))
        .is_err());
        let mut child = file();
        child["id"] = json!(2);
        child["parent"] = json!(1);
        assert!(parse(stream(
            vec![root(), file(), child],
            json!({"total_files":2,"total_size":14})
        ))
        .is_err());
    }
    #[test]
    fn rejects_mismatched_completion_and_root_modes() {
        for changes in [
            json!({"total_files":0}),
            json!({"total_dirs":2}),
            json!({"total_size":8}),
            json!({"bytes_sent":0}),
            json!({"scan_threads":0}),
            json!({"scan_threads":9}),
            json!({"errors":MAX_SAFE_INTEGER+1}),
        ] {
            assert!(parse(stream(vec![root(), file()], changes)).is_err());
        }
        let bytes = stream(vec![root(), file()], json!({}));
        assert!(read(&mut Cursor::new(bytes), true, |_| Ok(())).is_err());
        for root_path in ["relative", "", "/fixture/", "/fi\u{0}xture"] {
            let mut bad = start();
            bad["root"] = json!(root_path);
            assert!(parse(encode(&bad)).is_err());
        }
    }
    #[test]
    fn preserves_uncounted_root_mode_entries_and_rejects_children_under_them() {
        let mut bytes = encode(
            &json!({"type":"started","stream_version":1,"root":"/fixture","read_only":true}),
        );
        bytes.extend(encode(&json!({"type":"entries","entries":[root(),file(),
            {"id":2,"parent":0,"name":"alias","kind":"file","size":0,"counted":false}]})));
        let count = bytes.len();
        bytes.extend(encode(&json!({"type":"done","total_files":1,"total_dirs":1,"total_size":7,
            "errors":0,"skipped":1,"scan_time_ms":0,"scan_threads":1,"serialize_ms":0,"send_ms":0,"bytes_sent":count})));
        assert!(read(&mut Cursor::new(bytes), true, |_| Ok(())).is_ok());
        let alias =
            json!({"id":1,"parent":0,"name":"alias","kind":"directory","size":0,"counted":false});
        let mut child = file();
        child["id"] = json!(2);
        child["parent"] = json!(1);
        assert!(parse(stream(vec![root(), alias, child], json!({}))).is_err());
    }
    #[test]
    fn socket_deadline_does_not_reset_after_a_short_read() {
        use std::net::{TcpListener, TcpStream};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut peer, _) = listener.accept().unwrap();
        let mut reader = SocketReader::new(&mut client);
        let deadline = reader.deadline;
        peer.write_all(b"x").unwrap();
        let mut byte = [0];
        assert_eq!(reader.read(&mut byte).unwrap(), 1);
        assert_eq!(reader.deadline, deadline);
        // Expire the existing frame deadline while the next byte is buffered.
        reader.deadline = Instant::now() - Duration::from_millis(1);
        peer.write_all(b"y").unwrap();
        assert_eq!(
            reader.read(&mut byte).unwrap_err().kind(),
            std::io::ErrorKind::TimedOut
        );
        reader.begin_frame().unwrap();
        assert_eq!(reader.read(&mut byte).unwrap(), 1);
        assert_eq!(byte, [b'y']);
    }

    #[test]
    fn progress_failure_aborts_and_io_errors_after_done_are_not_success() {
        let bytes = stream(vec![root(), file()], json!({}));
        assert!(read(&mut Cursor::new(bytes.clone()), false, |_| Err(
            "view closed".into()
        ))
        .is_err());
        struct NoEof(Cursor<Vec<u8>>);
        impl StreamReader for NoEof {}
        impl Read for NoEof {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if self.0.position() == self.0.get_ref().len() as u64 {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "peer stayed open",
                    ))
                } else {
                    self.0.read(out)
                }
            }
        }
        assert!(read(&mut NoEof(Cursor::new(bytes)), false, |_| Ok(())).is_err());
    }
}
