//! Opt-in device experiment. Uses the real session/decoder, never the GUI.
use crate::{scan_stream, session, TCP_CONNECT_TIMEOUT, TCP_READ_TIMEOUT};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

const MODES: [u8; 4] = [1, 2, 4, 8];
const ORDER: [[u8; 4]; 5] = [
    [1, 4, 2, 8],
    [8, 2, 4, 1],
    [2, 1, 8, 4],
    [4, 8, 1, 2],
    [1, 8, 2, 4],
];
type Snapshot = BTreeMap<String, (u8, u64, bool)>;

#[derive(Default)]
pub(super) struct Cancellation {
    cancelled: AtomicBool,
    socket: Mutex<Option<TcpStream>>,
}
impl Cancellation {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err("Benchmark cancelled".into())
        } else {
            Ok(())
        }
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(socket) = self.socket.lock() {
            if let Some(socket) = socket.as_ref() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }
}

fn snapshot(response: &scan_stream::Response) -> Snapshot {
    let mut directories = BTreeMap::<u32, String>::new();
    let mut entries = BTreeMap::new();
    for (id, node) in response.nodes.iter().enumerate() {
        let path = if node.parent == scan_stream::NONE {
            response.root.clone()
        } else {
            let parent = &directories[&node.parent];
            format!("{}/{}", parent.trim_end_matches('/'), node.name)
        };
        let kind = match node.kind {
            scan_stream::Kind::Directory => 0,
            scan_stream::Kind::File => 1,
            scan_stream::Kind::Other => 2,
        };
        if kind == 0 {
            directories.insert(id as u32, path.clone());
        }
        entries.insert(path, (kind, node.size, node.counted));
    }
    entries
}

fn measure(
    connection: &session::Connection,
    root: &str,
    workers: u8,
    cancel: &Cancellation,
) -> Result<(Value, Snapshot), String> {
    cancel.check()?;
    if connection.read_only {
        return Err("Benchmark requires a non-root ADB shell: root/read-only scans are serial. No automatic unroot is attempted.".into());
    }
    let started = Instant::now();
    let mut socket = TcpStream::connect_timeout(&connection.address, TCP_CONNECT_TIMEOUT)
        .map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(TCP_READ_TIMEOUT))
        .map_err(|e| e.to_string())?;
    socket
        .set_write_timeout(Some(TCP_CONNECT_TIMEOUT))
        .map_err(|e| e.to_string())?;
    *cancel
        .socket
        .lock()
        .map_err(|_| "Benchmark cancellation unavailable")? =
        Some(socket.try_clone().map_err(|e| e.to_string())?);
    let result = (|| {
        cancel.check()?;
        let payload = crate::command_payload(&format!("SCAN_STREAM {root}"), &connection.token)?;
        socket
            .write_all(payload.as_bytes())
            .map_err(|e| e.to_string())?;
        let response = scan_stream::read(
            &mut scan_stream::SocketReader::new(&mut socket),
            false,
            |_| cancel.check(),
        )?;
        let stream_wall_ms = started.elapsed().as_secs_f64() * 1000.0;
        cancel.check()?;
        if response.root() != root {
            return Err("Daemon scanned an unexpected root".into());
        }
        let validation = Instant::now();
        let mut metadata = serde_json::to_value(&response).map_err(|e| e.to_string())?;
        metadata["root"] = json!(response.root());
        if metadata["scan_threads"].as_u64() != Some(workers as u64) {
            return Err(
                "Daemon did not run the requested worker count; no comparison recorded".into(),
            );
        }
        let tree = snapshot(&response);
        metadata["stream_wall_ms"] = json!(stream_wall_ms);
        metadata["snapshot_ms"] = json!(validation.elapsed().as_secs_f64() * 1000.0);
        Ok((metadata, tree))
    })();
    *cancel
        .socket
        .lock()
        .map_err(|_| "Benchmark cancellation unavailable")? = None;
    result
}

fn same_scan(
    reference: &Value,
    expected: &Snapshot,
    metadata: &Value,
    actual: &Snapshot,
) -> Result<(), String> {
    for field in [
        "root",
        "total_files",
        "total_dirs",
        "total_size",
        "errors",
        "skipped",
        "read_only",
    ] {
        if reference[field] != metadata[field] {
            return Err(format!("Scan {field} changed; results are not comparable. Choose a quiet folder and retry."));
        }
    }
    if expected != actual {
        return Err("Scanned paths, types, sizes or counted flags changed; results are not comparable. Choose a quiet folder and retry.".into());
    }
    Ok(())
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    }
}

pub(super) fn run(
    adb: PathBuf,
    daemon: PathBuf,
    serial: String,
    root: &str,
    output: &std::path::Path,
    cancel: &Cancellation,
) -> Result<Value, String> {
    if root.is_empty()
        || !root.starts_with('/')
        || root.contains(['\n', '\r', '\0'])
        || root.len() + "SCAN_STREAM ".len() > crate::MAX_COMMAND_BYTES
    {
        return Err(
            "Use an absolute scan path without line breaks, within the command limit".into(),
        );
    }
    cancel.check()?;
    crate::devices::require_selected(&adb, &serial)?;
    let targeted = |args: &[&str]| {
        let mut selected = vec!["-s", &serial];
        selected.extend_from_slice(args);
        crate::adb(&adb, &selected)
    };
    let model = targeted(&["shell", "getprop ro.product.model"])?;
    let android_sdk = targeted(&["shell", "getprop ro.build.version.sdk"])?;
    let version = crate::adb(&adb, &["version"])?;
    let mut sessions = BTreeMap::new();
    let outcome = (|| {
        for workers in MODES {
            cancel.check()?;
            eprintln!("Preparing {workers}-worker session...");
            let (session, _) =
                session::Session::start_benchmark(adb.clone(), &daemon, serial.clone(), workers)?;
            if session.connection().read_only {
                return Err("Benchmark requires a non-root ADB shell; root scans cannot compare parallel workers".into());
            }
            sessions.insert(workers, session);
        }
        let mut journal = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(output.join("trials.jsonl"))
            .map_err(|e| e.to_string())?;
        let mut reference = None;
        let mut rows = Vec::new();
        for (warmup, order) in
            std::iter::once((true, MODES)).chain(ORDER.into_iter().map(|order| (false, order)))
        {
            for workers in order {
                cancel.check()?;
                eprintln!(
                    "{}: {workers} workers",
                    if warmup { "Warm-up" } else { "Measured scan" }
                );
                let (mut metadata, tree) =
                    measure(&sessions[&workers].connection(), root, workers, cancel)?;
                if let Some((stats, snapshot)) = &reference {
                    same_scan(stats, snapshot, &metadata, &tree)?;
                } else {
                    reference = Some((metadata.clone(), tree));
                }
                metadata["warmup"] = json!(warmup);
                metadata["order"] = json!(rows.len() + 1);
                serde_json::to_writer(&mut journal, &metadata).map_err(|e| e.to_string())?;
                writeln!(journal).map_err(|e| e.to_string())?;
                journal.flush().map_err(|e| e.to_string())?;
                eprintln!(
                    "  scan {} ms; stream round-trip {:.1} ms",
                    metadata["scan_time_ms"],
                    metadata["stream_wall_ms"].as_f64().unwrap()
                );
                rows.push(metadata);
            }
        }
        let mut medians = Vec::new();
        for workers in MODES {
            let samples: Vec<_> = rows
                .iter()
                .filter(|row| row["warmup"] == false && row["scan_threads"] == workers)
                .collect();
            let mut daemon: Vec<_> = samples
                .iter()
                .map(|row| row["scan_time_ms"].as_f64().unwrap())
                .collect();
            let mut wall: Vec<_> = samples
                .iter()
                .map(|row| row["stream_wall_ms"].as_f64().unwrap())
                .collect();
            medians.push(json!({"workers":workers,"samples":samples.len(),"scan_ms":median(&mut daemon),"stream_wall_ms":median(&mut wall)}));
        }
        Ok(
            json!({"verified":true,"root":root,"device_model":model.trim(),"android_sdk":android_sdk.trim(),
            "adb_version":version.lines().take(2).collect::<Vec<_>>(),"host_os":std::env::consts::OS,"host_arch":std::env::consts::ARCH,
            "warmups_per_mode":1,"measured_runs_per_mode":5,"medians":medians,"runs":rows}),
        )
    })();
    let mut cleanup = Vec::new();
    for session in sessions.values_mut() {
        cleanup.extend(session.cleanup());
    }
    if !cleanup.is_empty() {
        return Err(format!(
            "Session cleanup incomplete: {}. Benchmark result: {}",
            cleanup.join("; "),
            if outcome.is_ok() {
                "measurements completed"
            } else {
                "failed"
            }
        ));
    }
    outcome
}

#[test]
#[ignore = "Live Android experiment: invoke through tests/benchmark_device_scan.py only"]
fn connected_device() {
    assert_eq!(
        std::env::var("SOCKETSWEEP_DEVICE_BENCH").as_deref(),
        Ok("1"),
        "Use tests/benchmark_device_scan.py; this test contacts a real device"
    );
    let env = |name| std::env::var(name).unwrap_or_else(|_| panic!("Missing {name}"));
    let cancel = Arc::new(Cancellation::default());
    let watcher = cancel.clone();
    std::thread::spawn(move || {
        let mut byte = [0];
        while matches!(std::io::stdin().read(&mut byte), Ok(n) if n > 0) {}
        watcher.cancel();
    });
    let output = PathBuf::from(env("SOCKETSWEEP_BENCH_OUTPUT"));
    let result = run(
        PathBuf::from(env("SOCKETSWEEP_BENCH_ADB")),
        PathBuf::from(env("SOCKETSWEEP_BENCH_DAEMON")),
        env("SOCKETSWEEP_BENCH_SERIAL"),
        &env("SOCKETSWEEP_BENCH_ROOT"),
        &output,
        &cancel,
    )
    .unwrap_or_else(|e| panic!("Benchmark failed: {e}"));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(output.join("measurements.json"))
        .unwrap();
    serde_json::to_writer_pretty(&mut file, &result).unwrap();
    writeln!(file).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::net::TcpListener;
    use std::time::Duration;

    fn frame(value: Value) -> Vec<u8> {
        let bytes = serde_json::to_vec(&value).unwrap();
        let mut result = (bytes.len() as u32).to_be_bytes().to_vec();
        result.extend(bytes);
        result
    }

    fn fixture(reversed: bool) -> Vec<u8> {
        let mut entries = vec![
            json!({"id":0,"parent":null,"name":"fixture","kind":"directory","size":0,"counted":true}),
        ];
        let dir =
            json!({"id":1,"parent":0,"name":"nested","kind":"directory","size":0,"counted":true});
        let a =
            json!({"id":2,"parent":1,"name":"exact ü name","kind":"file","size":7,"counted":true});
        let b = json!({"id":3,"parent":0,"name":"other","kind":"file","size":5,"counted":true});
        if reversed {
            let (mut dir, mut a, mut b) = (dir, a, b);
            b["id"] = json!(1);
            dir["id"] = json!(2);
            a["id"] = json!(3);
            a["parent"] = json!(2);
            entries.extend([b, dir, a]);
        } else {
            entries.extend([dir, a, b]);
        }
        let mut bytes = frame(
            json!({"type":"started","data":{"stream_version":1,"root":"/fixture","read_only":false}}),
        );
        bytes.extend(frame(json!({"type":"entries","data":{"entries":entries}})));
        bytes.extend(frame(json!({"type":"done","data":{"total_files":2,"total_dirs":2,"total_size":12,
            "errors":0,"skipped":0,"scan_time_ms":1,"scan_threads":4,"serialize_ms":0,"send_ms":0,"bytes_sent":bytes.len()}})));
        bytes
    }

    #[test]
    fn comparison_preserves_exact_tree_independent_of_parallel_arrival_order() {
        let parse =
            |order| scan_stream::read(&mut Cursor::new(fixture(order)), false, |_| Ok(())).unwrap();
        let expected = snapshot(&parse(false));
        let actual = snapshot(&parse(true));
        assert_eq!(expected, actual);
        assert!(actual.contains_key("/fixture/nested/exact ü name"));
        let metadata = serde_json::to_value(parse(false)).unwrap();
        same_scan(&metadata, &expected, &metadata, &actual).unwrap();
        for field in [
            "root",
            "total_files",
            "total_dirs",
            "total_size",
            "errors",
            "skipped",
            "read_only",
        ] {
            let mut changed = metadata.clone();
            changed[field] = json!("changed");
            assert!(
                same_scan(&metadata, &expected, &changed, &actual).is_err(),
                "{field}"
            );
        }
        for replacement in [(1, 6, true), (2, 5, true), (1, 5, false)] {
            let mut changed = actual.clone();
            changed.insert("/fixture/other".into(), replacement);
            assert!(same_scan(&metadata, &expected, &metadata, &changed).is_err());
        }
        let mut renamed = actual;
        renamed.remove("/fixture/other");
        renamed.insert("/fixture/renamed".into(), (1, 5, true));
        assert!(same_scan(&metadata, &expected, &metadata, &renamed).is_err());
    }

    #[test]
    fn measurement_rejects_wrong_root_and_worker_count() {
        for (root, workers, expected) in [
            ("/wrong", 4, "unexpected root"),
            ("/fixture", 2, "requested worker count"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let connection = session::Connection {
                address: listener.local_addr().unwrap(),
                token: "0".repeat(64),
                read_only: false,
            };
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut input = std::io::BufReader::new(socket.try_clone().unwrap());
                let mut command = String::new();
                for _ in 0..2 {
                    std::io::BufRead::read_line(&mut input, &mut command).unwrap();
                }
                socket.write_all(&fixture(false)).unwrap();
            });
            let cancel = Cancellation::default();
            assert!(measure(&connection, root, workers, &cancel)
                .unwrap_err()
                .contains(expected));
            assert!(cancel.socket.lock().unwrap().is_none());
            server.join().unwrap();
        }
    }

    #[test]
    fn cancellation_closes_active_socket_and_prevents_further_work() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_peer, _) = listener.accept().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let cancel = Cancellation::default();
        *cancel.socket.lock().unwrap() = Some(client.try_clone().unwrap());
        cancel.cancel();
        assert!(cancel.check().is_err());
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
    }
}
