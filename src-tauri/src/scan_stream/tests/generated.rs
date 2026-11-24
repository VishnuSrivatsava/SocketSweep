use super::{encode, file, root, start};
use crate::scan_stream::{read, Kind, StreamReader, MAX_FRAME_BYTES, NONE};
use serde_json::{json, Value};
use std::io::{self, Cursor, Read};

const SEEDS: u64 = 32;

struct Generator(u64);

impl Generator {
    fn below(&mut self, limit: usize) -> usize {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
        (self.0 >> 32) as usize % limit
    }
}

struct ShortReads {
    bytes: Cursor<Vec<u8>>,
    limit: usize,
}

impl Read for ShortReads {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let len = buf.len().min(self.limit);
        self.bytes.read(&mut buf[..len])
    }
}

impl StreamReader for ShortReads {}

fn entries(generator: &mut Generator) -> Vec<Value> {
    let mut entries = vec![root(), file()];
    let mut directories = vec![0];
    for id in 2..(10 + generator.below(24)) {
        let parent = directories[generator.below(directories.len())];
        let (kind, size, counted) = match generator.below(4) {
            0 => {
                directories.push(id);
                ("directory", 0, true)
            }
            1 => ("other", 0, false),
            2 => ("file", 0, true),
            _ => ("file", generator.below(8192), true),
        };
        let prefix = ["plain", "café", "\"quoted\"", "with space", "line\nbreak"];
        let name = format!("{}-{id}", prefix[generator.below(prefix.len())]);
        entries.push(json!({"id":id,"parent":parent,"name":name,"kind":kind,
            "size":size,"counted":counted}));
    }
    entries
}

fn stream(
    entries: &[Value],
    batch_size: usize,
    read_only: bool,
    byte_count_offset: usize,
) -> Vec<u8> {
    let total_dirs = entries
        .iter()
        .filter(|entry| entry["kind"] == "directory")
        .count();
    let total_files = entries
        .iter()
        .filter(|entry| entry["kind"] == "file")
        .count();
    let total_size: u64 = entries
        .iter()
        .map(|entry| entry["size"].as_u64().unwrap())
        .sum();
    let mut started = start();
    started["read_only"] = json!(read_only);
    let mut bytes = encode(&started);
    // Root and file are in the first batch, separate from entries that reference them.
    bytes.extend(encode(&json!({"type":"entries","entries":entries[..2]})));
    for batch in entries[2..].chunks(batch_size) {
        bytes.extend(encode(&json!({"type":"entries","entries":batch})));
    }
    bytes.extend(encode(
        &json!({"type":"done","total_files":total_files,"total_dirs":total_dirs,
        "total_size":total_size,"errors":0,"skipped":0,"scan_time_ms":1,
        "scan_threads":if read_only { 1 } else { 4 },"serialize_ms":0,"send_ms":0,
        "bytes_sent":bytes.len() + byte_count_offset}),
    ));
    bytes
}

#[test]
fn generated_trees_decode_across_batches_and_short_reads() {
    for seed in 0..SEEDS {
        let mut generator = Generator(seed);
        let entries = entries(&mut generator);
        let read_only = seed % 2 == 0;
        let bytes = stream(&entries, 1 + generator.below(7), read_only, 0);
        let mut reader = ShortReads {
            bytes: Cursor::new(bytes),
            limit: 1 + generator.below(17),
        };
        let response = read(&mut reader, read_only, |_| Ok(()))
            .unwrap_or_else(|error| panic!("seed {seed}: {error}"));

        assert_eq!(response.root(), "/fixture", "seed {seed}");
        assert_eq!(response.read_only, read_only, "seed {seed}");
        assert_eq!(response.nodes.len(), entries.len(), "seed {seed}");
        assert_eq!(response.nodes[0].size, response.total_size, "seed {seed}");
        assert_eq!(response.nodes[0].files, response.total_files, "seed {seed}");
        assert_eq!(
            response.nodes[0].directories, response.total_dirs,
            "seed {seed}"
        );
        for (id, (node, entry)) in response.nodes.iter().zip(entries).enumerate() {
            let kind = match entry["kind"].as_str().unwrap() {
                "file" => Kind::File,
                "directory" => Kind::Directory,
                "other" => Kind::Other,
                _ => unreachable!(),
            };
            assert!(node.kind == kind, "seed {seed}, entry {id}");
            assert_eq!(
                &*node.name,
                entry["name"].as_str().unwrap(),
                "seed {seed}, entry {id}"
            );
            let parent = entry["parent"]
                .as_u64()
                .map_or(NONE, |parent| parent as u32);
            assert_eq!(node.parent, parent, "seed {seed}, entry {id}");
            assert_eq!(
                node.counted,
                entry["counted"].as_bool().unwrap(),
                "seed {seed}, entry {id}"
            );
            if kind != Kind::Directory {
                assert_eq!(
                    node.size,
                    entry["size"].as_u64().unwrap(),
                    "seed {seed}, entry {id}"
                );
            }
        }
    }
}

#[test]
fn generated_stream_mutations_are_rejected() {
    for seed in 0..SEEDS {
        let mut generator = Generator(seed);
        let mut entries = entries(&mut generator);
        let read_only = seed % 2 == 0;
        let batch_size = 1 + generator.below(7);
        let valid = stream(&entries, batch_size, read_only, 0);
        let reject =
            |bytes: &[u8], mutation| match read(&mut Cursor::new(bytes), read_only, |_| Ok(())) {
                Ok(_) => panic!("seed {seed} accepted {mutation}"),
                Err(error) => error,
            };

        reject(&valid[..generator.below(valid.len())], "truncation");
        let mut oversized = valid;
        oversized[..4].copy_from_slice(&(MAX_FRAME_BYTES as u32 + 1).to_be_bytes());
        assert_eq!(
            reject(&oversized, "oversized frame length"),
            "Invalid scan frame size",
            "seed {seed}",
        );
        assert_eq!(
            reject(
                &stream(&entries, batch_size, read_only, 1),
                "incorrect terminal byte count"
            ),
            "Scan completion does not match received entries or negotiated mode",
            "seed {seed}",
        );

        let first_file_name = entries[1]["name"].clone();
        entries.last_mut().unwrap()["parent"] = json!(1);
        assert_eq!(
            reject(
                &stream(&entries, batch_size, read_only, 0),
                "child attached to file in earlier batch"
            ),
            "Invalid scan parent or filename",
            "seed {seed}",
        );

        let last = entries.last_mut().unwrap();
        last["parent"] = json!(0);
        last["name"] = first_file_name;
        assert_eq!(
            reject(
                &stream(&entries, batch_size, read_only, 0),
                "duplicate sibling across batches"
            ),
            "Duplicate filename in scan directory",
            "seed {seed}",
        );
    }
}

#[test]
fn arbitrary_bytes_are_rejected() {
    for seed in 0..SEEDS {
        let mut generator = Generator(seed);
        let size = 1 + generator.below(512);
        let payload: Vec<u8> = (0..size).map(|_| generator.below(256) as u8).collect();
        let mut framed = (size as u32).to_be_bytes().to_vec();
        framed.extend_from_slice(&payload);
        for bytes in [&payload, &framed] {
            assert!(
                read(&mut Cursor::new(bytes), false, |_| Ok(())).is_err(),
                "seed {seed} accepted arbitrary bytes",
            );
        }
    }
}
