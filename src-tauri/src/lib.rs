// ============================================================================
// lib.rs — SocketSweep Tauri Bridge (Phase 2)
// ============================================================================
// Orchestrates the C++ Android daemon via ADB and communicates with it
// over a TCP tunnel.  All commands return Result<String, String> so the
// React frontend can display meaningful error messages.
//
// Wire protocol (matches Phase 1 daemon):
// Each connection starts with "AUTH <session token>\n", then one command.
//   → "PING\n"              ← {"status":"ok","protocol_version":3,"uid":…,"read_only":…}
//   → "SCAN_STREAM path\n" ← length-prefixed JSON frames (scan stream v1)
//   → "SCAN [path]\n"       ← legacy whole-tree JSON (diagnostics/tests)
//   → "SHUTDOWN\n"          ← {"status":"ok","message":"shutting down"}
// ============================================================================

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tauri::ipc::Channel;
mod scan_stream;
mod scan_store;
mod session;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

// ── Constants ───────────────────────────────────────────────────────────────

const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_COMMAND_BYTES: usize = 16 * 1024;
const MAX_COMMAND_RESPONSE_BYTES: usize = 128 * 1024;
const TCP_READ_TIMEOUT: Duration = Duration::from_secs(120); // scans can be slow

/// Only complete, current snapshots authorize queries and deletion IDs.
static SCAN_STORE: Mutex<Option<scan_store::Catalog>> = Mutex::new(None);

fn invalidate_scan() -> Result<(), String> {
    *SCAN_STORE.lock().map_err(|_| "Scan state is unavailable")? = None;
    Ok(())
}

/// A published session owns all connection state and cleanup authority.
static SESSION: Mutex<Option<session::Session>> = Mutex::new(None);
// Keep connection changes, scans, and deletes in order across async commands.
static DAEMON_OPERATION: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Privilege {
    Shell,
    Su,
}

fn select_privilege(
    root_mode: bool,
    mut execute: impl FnMut(&[&str]) -> Result<String, String>,
) -> Result<Privilege, String> {
    if !root_mode {
        return Ok(Privilege::Shell);
    }
    if execute(&["shell", "id -u"])?.trim() == "0" {
        return Ok(Privilege::Shell); // adbd was already started as root
    }
    if execute(&["shell", "su -c 'id -u'"]).is_ok_and(|uid| uid.trim() == "0") {
        return Ok(Privilege::Su);
    }
    Err("Root access was not granted. Approve shell access in your phone's root manager and retry, or use adb root on a supported debug build before connecting.".into())
}

fn device_shell_command(privilege: Privilege, command: &str) -> String {
    match privilege {
        Privilege::Shell => command.to_string(),
        Privilege::Su => format!("su -c '{}'", command.replace('\'', "'\\''")),
    }
}

// ── Resource Resolution ─────────────────────────────────────────────────────

use tauri::Manager;

fn get_bundled_binary(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| format!("Failed to get resource dir: {}", e))?;

    // On Windows, host-native binaries like ADB use a .exe extension.
    // Try the .exe variant first, then fall back to the extensionless name
    // (needed for cross-platform binaries like the Android daemon).
    #[cfg(target_os = "windows")]
    {
        let exe_path = resource_dir.join("bin").join(format!("{name}.exe"));
        if exe_path.exists() {
            return Ok(exe_path);
        }
    }

    let path = resource_dir.join("bin").join(name);
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("Bundled binary '{}' not found at {:?}", name, path))
    }
}

// ── ADB helper ──────────────────────────────────────────────────────────────

/// Run an ADB command and return its stdout. Maps any failure to a
/// human-readable `Err(String)`.
fn adb(adb_path: &std::path::Path, args: &[&str]) -> Result<String, String> {
    adb_with_input(adb_path, args, None)
}

fn adb_with_input(adb_path: &std::path::Path, args: &[&str], input: Option<&[u8]>) -> Result<String, String> {
    adb_with_input_timeout(adb_path, args, input, Duration::from_secs(15))
}

fn adb_with_input_timeout(adb_path: &std::path::Path, args: &[&str], input: Option<&[u8]>, timeout: Duration) -> Result<String, String> {
    use std::sync::mpsc::{sync_channel, Receiver};
    use std::time::Instant;
    const LIMIT: usize = 256 * 1024;
    // The only input is a 65-byte startup token. Keep writes smaller than an
    // empty pipe's capacity; a blocked child cannot stall a large stdin write.
    if input.is_some_and(|bytes| bytes.len() > 128) { return Err("ADB input exceeds limit".into()); }
    if timeout.is_zero() { return Err("ADB command timed out".into()); }
    let deadline = Instant::now() + timeout;
    let mut child = Command::new(adb_path).args(args)
        .stdin(if input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped())
        .spawn().map_err(|e| format!("Failed to execute adb binary at {:?}: {e}", adb_path))?;
    fn read_pipe(pipe: impl Read + Send + 'static) -> Receiver<Result<Vec<u8>, String>> {
        let (send, receive) = sync_channel(1);
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.take((LIMIT + 1) as u64).read_to_end(&mut bytes)
                .map_err(|e| format!("Cannot read ADB output: {e}"))
                .and_then(|_| if bytes.len() > LIMIT { Err("ADB output exceeds limit".into()) } else { Ok(bytes) });
            let _ = send.send(result);
        });
        receive
    }
    let stdout = read_pipe(child.stdout.take().unwrap());
    let stderr = read_pipe(child.stderr.take().unwrap());
    let result = (|| {
        if let Some(input) = input {
            child.stdin.take().unwrap().write_all(input).map_err(|e| format!("Cannot provide ADB input: {e}"))?;
        }
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| format!("Cannot wait for ADB: {e}"))? { break status; }
            if Instant::now() >= deadline { return Err("ADB command timed out. Reconnect your device and retry.".into()); }
            std::thread::sleep(Duration::from_millis(10));
        };
        let receive = |pipe: Receiver<Result<Vec<u8>, String>>| {
            pipe.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| "ADB output timed out".to_string())?
        };
        let stdout = String::from_utf8_lossy(&receive(stdout)?).into_owned();
        let stderr = String::from_utf8_lossy(&receive(stderr)?).into_owned();
        if !status.success() {
            let combined = format!("{stdout} {stderr}").to_lowercase();
            if combined.contains("no devices") || combined.contains("device not found") {
                return Err("No Android device detected. Connect your phone via USB and enable USB Debugging.".into());
            }
            if combined.contains("unauthorized") {
                return Err("USB Debugging not authorised. Check the confirmation dialog on your phone.".into());
            }
            return Err(format!("adb {} failed (exit {}):\n{stderr}", args.join(" "), status.code().unwrap_or(-1)));
        }
        Ok(stdout)
    })();
    if result.is_err() { let _ = child.kill(); let _ = child.wait(); }
    result
}

// ── TCP helper ──────────────────────────────────────────────────────────────

/// Send a one-line command to the daemon and read the full response.
fn active_connection() -> Result<session::Connection, String> {
    SESSION.lock().map_err(|_| "Session state is unavailable")?
        .as_ref().map(session::Session::connection)
        .ok_or_else(|| "No active daemon session. Connect your device first.".into())
}

fn daemon_command(cmd: &str) -> Result<String, String> {
    let connection = active_connection()?;
    daemon_command_at(connection.address, cmd, &connection.token, TCP_READ_TIMEOUT)
}

fn command_payload(cmd: &str, token: &str) -> Result<String, String> {
    if cmd.is_empty() || cmd.len() > MAX_COMMAND_BYTES || cmd.contains(['\r', '\n', '\0']) {
        return Err("This path cannot be sent safely: it contains a line break or null byte, or is too long.".into());
    }
    Ok(format!("AUTH {token}\n{cmd}\n"))
}

fn daemon_command_at(address: std::net::SocketAddr, cmd: &str, token: &str, timeout: Duration) -> Result<String, String> {
    let payload = command_payload(cmd, token)?;
    let deadline = std::time::Instant::now() + timeout;
    let left = || {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() { Err("Daemon command timed out".to_string()) } else { Ok(left) }
    };
    let mut stream = TcpStream::connect_timeout(&address, TCP_CONNECT_TIMEOUT.min(left()?))
        .map_err(|e| format!("Cannot connect to daemon at {address}: {e}"))?;
    let mut sent = 0;
    while sent < payload.len() {
        stream.set_write_timeout(Some(TCP_CONNECT_TIMEOUT.min(left()?))).map_err(|e| e.to_string())?;
        match stream.write(&payload.as_bytes()[sent..]) {
            Ok(0) => return Err("Daemon command connection closed".into()),
            Ok(n) => sent += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("Failed to send command to daemon: {e}")),
        }
    }
    let mut response = Vec::with_capacity(1024);
    let mut buffer = [0; 4096];
    loop {
        stream.set_read_timeout(Some(left()?)).map_err(|e| e.to_string())?;
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                if n > MAX_COMMAND_RESPONSE_BYTES.saturating_sub(response.len()) { return Err("Daemon command response exceeds limit".into()); }
                response.extend_from_slice(&buffer[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("Failed to read daemon response: {e}")),
        }
    }
    decode_daemon_response(response)
}

fn decode_daemon_response(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > MAX_COMMAND_RESPONSE_BYTES {
        return Err("Daemon command response exceeds limit".into());
    }
    // Replacement characters would change paths, potentially selecting a
    // different file when a displayed node is later deleted.
    String::from_utf8(bytes)
        .map(|response| response.trim().to_string())
        .map_err(|_| "Daemon returned invalid UTF-8 filenames. This scan cannot be displayed safely.".into())
}

#[derive(serde::Deserialize)]
struct DaemonStatus {
    status: String,
    message: Option<String>,
    protocol_version: Option<u32>,
    scan_stream_version: Option<u32>,
    uid: Option<u32>,
    read_only: Option<bool>,
}

fn require_handshake(response: &str, root_mode: bool) -> Result<DaemonStatus, String> {
    let parsed = require_ok(response)?;
    if parsed.protocol_version != Some(3) || parsed.scan_stream_version != Some(1) || parsed.uid.is_none() || parsed.read_only.is_none() {
        return Err("Bundled daemon is outdated. Rebuild it before connecting.".into());
    }
    if (root_mode && parsed.uid != Some(0)) || (parsed.uid == Some(0) && parsed.read_only != Some(true)) {
        return Err("Daemon did not start with read-only root access.".into());
    }
    if root_mode && parsed.read_only != Some(true) {
        return Err("Root scans must be read-only.".into());
    }
    Ok(parsed)
}

fn require_ok(response: &str) -> Result<DaemonStatus, String> {
    // Ignore the tree here rather than allocating a second copy of the scan.
    let parsed: DaemonStatus = serde_json::from_str(response)
        .map_err(|_| "Daemon returned an invalid response".to_string())?;
    if parsed.status != "ok" {
        return Err(parsed.message.unwrap_or_else(|| "Daemon command failed".into()));
    }
    Ok(parsed)
}

fn new_random_id() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Failed to create secure identifier: {e}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command(async)]
fn check_adb(app: tauri::AppHandle) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let version = adb(&adb_path, &["version"])?;
    let first_line = version.lines().next().unwrap_or("unknown").to_string();
    Ok(first_line)
}

#[tauri::command(async)]
fn init_daemon(app: tauri::AppHandle, root_mode: Option<bool>) -> Result<String, String> {
    let _operation = DAEMON_OPERATION.lock().map_err(|_| "Daemon state is unavailable")?;
    // Reconnect can release only this app's previous session. An unconfirmed
    // remote stop still clears local authority before a fresh session starts.
    let _ = stop_daemon_inner();
    let adb_path = get_bundled_binary(&app, "adb")?;
    let daemon = get_bundled_binary(&app, "daemon")?;
    adb(&adb_path, &["version"])?;
    let devices = adb(&adb_path, &["devices"])?;
    let serial = devices.lines().find(|line| line.ends_with("\tdevice") && !line.starts_with("List"))
        .and_then(|line| line.split('\t').next()).map(str::to_string)
        .ok_or_else(|| if devices.lines().any(|line| line.contains("unauthorized")) {
            "USB Debugging not authorised. Check the confirmation dialog on your phone.".to_string()
        } else { "No Android device detected. Connect your phone via USB and enable USB Debugging.".to_string() })?;
    let (session, response) = session::Session::start(adb_path, &daemon, serial, root_mode.unwrap_or(false))?;
    *SESSION.lock().map_err(|_| "Session state is unavailable")? = Some(session);
    Ok(response)
}

// Cancellation deliberately bypasses DAEMON_OPERATION: otherwise it would
// wait for the scan it is meant to stop. IDs prevent a late click cancelling
// another scan. Registration happens before connect, so early clicks count.
struct ActiveScan {
    id: String,
    cancelled: Arc<AtomicBool>,
    progress_pending: Arc<AtomicBool>,
    socket: Option<TcpStream>,
}
static ACTIVE_SCAN: Mutex<Option<ActiveScan>> = Mutex::new(None);
struct ScanRegistration(String);
impl Drop for ScanRegistration {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_SCAN.lock() {
            if active.as_ref().is_some_and(|scan| scan.id == self.0) {
                if let Some(socket) = active.take().and_then(|scan| scan.socket) {
                    let _ = socket.shutdown(Shutdown::Both);
                }
            }
        }
    }
}
#[derive(serde::Serialize)]
struct ScanProgress {
    scan_id: String,
    #[serde(flatten)]
    progress: scan_stream::Progress,
}

// At most one progress message may await delivery/acknowledgement. A slow
// webview cannot turn progress events into an unbounded IPC payload queue.
#[tauri::command(async)]
fn acknowledge_scan_progress(scan_id: String) -> Result<(), String> {
    let active = ACTIVE_SCAN
        .lock()
        .map_err(|_| "Scan state is unavailable")?;
    if let Some(scan) = active.as_ref().filter(|scan| scan.id == scan_id) {
        scan.progress_pending.store(false, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command(async)]
fn cancel_scan(scan_id: String) -> Result<(), String> {
    let active = ACTIVE_SCAN
        .lock()
        .map_err(|_| "Scan state is unavailable")?;
    if let Some(scan) = active.as_ref().filter(|scan| scan.id == scan_id) {
        scan.cancelled.store(true, Ordering::SeqCst);
        if let Some(socket) = &scan.socket {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
    Ok(())
}

#[tauri::command(async)]
fn run_scan(
    path: Option<String>,
    scan_id: String,
    on_progress: Channel<ScanProgress>,
) -> Result<String, String> {
    if scan_id.is_empty()
        || scan_id.len() > 64
        || !scan_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid scan identifier".into());
    }
    let _operation = DAEMON_OPERATION
        .lock()
        .map_err(|_| "Daemon state is unavailable")?;
    invalidate_scan()?;
    let effective_root = path
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "/sdcard".into());
    let connection = active_connection()?;
    let payload = command_payload(&format!("SCAN_STREAM {effective_root}"), &connection.token)?;
    let read_only = connection.read_only;
    let cancelled = Arc::new(AtomicBool::new(false));
    let progress_pending = Arc::new(AtomicBool::new(false));
    *ACTIVE_SCAN
        .lock()
        .map_err(|_| "Scan state is unavailable")? = Some(ActiveScan {
        id: scan_id.clone(),
        cancelled: cancelled.clone(),
        progress_pending: progress_pending.clone(),
        socket: None,
    });
    let _registration = ScanRegistration(scan_id.clone());
    let result = (|| {
        let mut stream =
            TcpStream::connect_timeout(&connection.address, TCP_CONNECT_TIMEOUT)
                .map_err(|e| format!("Cannot connect to daemon at {}: {e}", connection.address))?;
        stream
            .set_read_timeout(Some(TCP_READ_TIMEOUT))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(TCP_CONNECT_TIMEOUT))
            .map_err(|e| e.to_string())?;
        {
            let mut active = ACTIVE_SCAN
                .lock()
                .map_err(|_| "Scan state is unavailable")?;
            if cancelled.load(Ordering::SeqCst) {
                return Err("Scan cancelled".into());
            }
            active.as_mut().unwrap().socket = Some(stream.try_clone().map_err(|e| e.to_string())?);
        }
        stream
            .write_all(payload.as_bytes())
            .map_err(|e| format!("Failed to send scan command: {e}"))?;
        let response = scan_stream::read(
            &mut scan_stream::SocketReader::new(&mut stream),
            read_only,
            |progress| {
                if cancelled.load(Ordering::SeqCst) {
                    return Err("Scan cancelled".into());
                }
                if progress_pending
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    return Ok(()); // coalesce updates while the previous one awaits acknowledgement
                }
                on_progress
                    .send(ScanProgress {
                        scan_id: scan_id.clone(),
                        progress: progress.clone(),
                    })
                    .map_err(|e| format!("Cannot deliver scan progress: {e}"))
            },
        )?;
        if !read_only {
            let normalized = effective_root.trim_end_matches('/');
            let normalized = if normalized.is_empty() { "/" } else { normalized };
            if response.root() != normalized {
                return Err("Daemon scanned an unexpected root".into());
            }
        }
        // Public snapshot generations are independent of the secret daemon token.
        let catalog = scan_store::Catalog::new(response, new_random_id()?);
        let json = catalog.summary_json()?;
        // Serialize bounded metadata before publishing deletion authority.
        let mut active = ACTIVE_SCAN
            .lock()
            .map_err(|_| "Scan state is unavailable")?;
        if cancelled.load(Ordering::SeqCst) {
            return Err("Scan cancelled".into());
        }
        *SCAN_STORE.lock().map_err(|_| "Scan state is unavailable")? = Some(catalog);
        active.take();
        Ok(json)
    })();
    if cancelled.load(Ordering::SeqCst) {
        Err("Scan cancelled".into())
    } else {
        result
    }
}

#[tauri::command(async)]
fn ping_daemon() -> Result<String, String> {
    let _operation = DAEMON_OPERATION.lock().map_err(|_| "Daemon state is unavailable")?;
    daemon_command("PING")
}

#[tauri::command(async)]
fn stop_daemon() -> Result<String, String> {
    let _operation = DAEMON_OPERATION.lock().map_err(|_| "Daemon state is unavailable")?;
    stop_daemon_inner()
}

fn confirm_shutdown(response: &str) -> Result<(), String> {
    let status = require_ok(response)?;
    if status.message.as_deref() != Some("shutting down") {
        return Err("Daemon did not acknowledge shutdown".into());
    }
    Ok(())
}

fn clear_session() -> Result<(), String> {
    invalidate_scan()?;
    let session = SESSION.lock().map_err(|_| "Session state is unavailable")?.take();
    drop(session); // release the lock before bounded remote cleanup
    Ok(())
}

fn finish_stop(result: Result<String, String>) -> Result<String, String> {
    clear_session()?;
    result
}

fn stop_daemon_inner() -> Result<String, String> {
    invalidate_scan()?;
    let mut session = SESSION.lock().map_err(|_| "Session state is unavailable")?
        .take().ok_or("No active daemon session")?;
    let connection = session.connection();
    let response = daemon_command_at(connection.address, "SHUTDOWN", &connection.token, Duration::from_secs(3));
    // EOF also retires this exact process after an unreachable/rejected reply,
    // but cleanup cannot substitute for the remote acknowledgement in the UI.
    for error in session.cleanup() { eprintln!("Session cleanup incomplete: {error}"); }
    finish_stop(response.and_then(|response| { confirm_shutdown(&response)?; Ok(response) }))
}

#[tauri::command(async)]
fn get_scan_view(
    generation: String,
    revision: u32,
    node_id: u32,
    cursor: Option<scan_store::Cursor>,
) -> Result<String, String> {
    let store = SCAN_STORE.lock().map_err(|_| "Scan state is unavailable")?;
    store
        .as_ref()
        .ok_or("Scan is unavailable; rescan required")?
        .view_json(&generation, revision, node_id, cursor)
}

#[tauri::command(async)]
fn get_scan_node(generation: String, revision: u32, node_id: u32) -> Result<String, String> {
    let store = SCAN_STORE.lock().map_err(|_| "Scan state is unavailable")?;
    store
        .as_ref()
        .ok_or("Scan is unavailable; rescan required")?
        .detail_json(&generation, revision, node_id)
}

#[tauri::command(async)]
fn delete_item(generation: String, revision: u32, node_id: u32) -> Result<String, String> {
    let _operation = DAEMON_OPERATION
        .lock()
        .map_err(|_| "Daemon state is unavailable")?;
    let plan = {
        let store = SCAN_STORE.lock().map_err(|_| "Scan state is unavailable")?;
        store
            .as_ref()
            .ok_or("Scan your device before deleting files.")?
            .prepare_delete(&generation, revision, node_id)?
    };
    let response = daemon_command(&format!("DELETE {}", plan.path));
    let mut store = SCAN_STORE.lock().map_err(|_| "Scan state is unavailable")?;
    scan_store::finish_delete(&mut store, &plan, response)
}

// ── Tauri entry point ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            check_adb,
            init_daemon,
            run_scan,
            cancel_scan,
            acknowledge_scan_progress,
            ping_daemon,
            stop_daemon,
            delete_item,
            get_scan_view,
            get_scan_node,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Ok(active) = ACTIVE_SCAN.lock() {
                    if let Some(scan) = active.as_ref() {
                        scan.cancelled.store(true, Ordering::SeqCst);
                        if let Some(socket) = &scan.socket { let _ = socket.shutdown(Shutdown::Both); }
                    }
                }
                let _ = clear_session();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_access_is_explicit_and_verified_without_restarting_adbd() {
        assert_eq!(select_privilege(false, |_| panic!("Normal mode must not request root")).unwrap(), Privilege::Shell);
        assert_eq!(select_privilege(true, |args| {
            assert_eq!(args, ["shell", "id -u"]);
            Ok("0\n".into())
        }).unwrap(), Privilege::Shell);
        let mut calls = Vec::new();
        assert_eq!(select_privilege(true, |args| {
            calls.push(args.join(" "));
            Ok(if calls.len() == 1 { "2000\n" } else { "0\n" }.into())
        }).unwrap(), Privilege::Su);
        assert_eq!(calls, ["shell id -u", "shell su -c 'id -u'"]);
        assert!(select_privilege(true, |_| Ok("2000\n".into())).is_err());
        assert!(select_privilege(true, |_| Err("permission denied".into())).is_err());
    }

    #[test]
    fn root_handshake_rejects_wrong_uid_writable_daemon_and_old_protocol() {
        let response = |version, uid, read_only| format!("{{\"status\":\"ok\",\"protocol_version\":{version},\"scan_stream_version\":1,\"uid\":{uid},\"read_only\":{read_only}}}");
        assert!(require_handshake(&response(3, 0, true), true).is_ok());
        assert!(require_handshake(&response(3, 2000, false), false).is_ok());
        assert!(require_handshake(&response(3, 0, true), false).is_ok());
        assert!(require_handshake(&response(3, 2000, true), true).is_err());
        assert!(require_handshake(&response(3, 0, false), true).is_err());
        assert!(require_handshake(&response(3, 0, false), false).is_err());
        assert!(require_handshake(&response(2, 0, true), true).is_err());
        assert!(require_handshake("{\"status\":\"ok\",\"protocol_version\":3}", true).is_err());
        assert!(require_handshake("{\"status\":\"ok\",\"protocol_version\":3,\"uid\":2000,\"read_only\":false}", false).is_err());
    }

    #[test]
    fn su_wraps_the_complete_shell_command_without_exposing_its_quotes() {
        let command = "pkill -f '[s]ocketsweep_daemon' || true";
        assert_eq!(device_shell_command(Privilege::Shell, command), command);
        let wrapped = device_shell_command(Privilege::Su, command);
        assert_eq!(wrapped, "su -c 'pkill -f '\\''[s]ocketsweep_daemon'\\'' || true'");
    }

    #[test]
    fn paths_keep_their_exact_spaces() {
        assert_eq!(command_payload("DELETE /sdcard/ report ", "token").unwrap(),
            "AUTH token\nDELETE /sdcard/ report \n");
    }

    #[test]
    fn paths_with_protocol_delimiters_are_rejected() {
        for path in ["/sdcard/report\nother", "/sdcard/report\r", "/sdcard/report\0other"] {
            assert!(command_payload(&format!("DELETE {path}"), "token").is_err());
            assert!(command_payload(&format!("SCAN {path}"), "token").is_err());
        }
        assert!(command_payload(&"x".repeat(16 * 1024 + 1), "token").is_err());
    }

    #[test]
    fn random_identifiers_are_fresh_and_have_full_entropy() {
        let first = new_random_id().unwrap();
        let second = new_random_id().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn shutdown_requires_the_actual_acknowledgement() {
        assert!(confirm_shutdown(r#"{"status":"ok","message":"shutting down"}"#).is_ok());
        for response in ["", "daemon already stopped", "{", "null", r#"{"status":"ok"}"#,
            r#"{"status":"ok","message":"pong"}"#, r#"{"status":"error","message":"Authentication failed"}"#] {
            assert!(confirm_shutdown(response).is_err(), "accepted {response}");
        }
    }

    #[test]
    fn daemon_errors_cannot_be_treated_as_success() {
        assert!(require_ok("{\"status\":\"ok\"}").is_ok());
        assert!(require_ok("{\"status\":\"error\",\"message\":\"Authentication failed\"}").is_err());
        assert!(require_ok("invalid").is_err());
    }

    #[test]
    fn cancellation_is_scoped_to_the_active_id_and_registration_cleans_up() {
        let _operation = DAEMON_OPERATION.lock().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        *ACTIVE_SCAN.lock().unwrap() = Some(ActiveScan {
            id: "current".into(), cancelled: cancelled.clone(), progress_pending: Arc::new(AtomicBool::new(true)), socket: None,
        });
        let registration = ScanRegistration("current".into());
        acknowledge_scan_progress("previous".into()).unwrap();
        assert!(ACTIVE_SCAN.lock().unwrap().as_ref().unwrap().progress_pending.load(Ordering::SeqCst));
        acknowledge_scan_progress("current".into()).unwrap();
        assert!(!ACTIVE_SCAN.lock().unwrap().as_ref().unwrap().progress_pending.load(Ordering::SeqCst));
        cancel_scan("previous".into()).unwrap();
        assert!(!cancelled.load(Ordering::SeqCst));
        cancel_scan("current".into()).unwrap();
        assert!(cancelled.load(Ordering::SeqCst));
        drop(registration);
        assert!(ACTIVE_SCAN.lock().unwrap().is_none());
        // An old guard must not clear a newer scan registration.
        *ACTIVE_SCAN.lock().unwrap() = Some(ActiveScan {
            id: "next".into(), cancelled, progress_pending: Arc::new(AtomicBool::new(false)), socket: None,
        });
        drop(ScanRegistration("current".into()));
        assert!(ACTIVE_SCAN.lock().unwrap().is_some());
        drop(ScanRegistration("next".into()));
    }

    #[test]
    fn small_command_responses_have_a_hard_byte_limit() {
        assert!(decode_daemon_response(vec![b'x'; MAX_COMMAND_RESPONSE_BYTES]).is_ok());
        assert!(decode_daemon_response(vec![b'x'; MAX_COMMAND_RESPONSE_BYTES + 1]).is_err());
    }

    #[test]
    fn small_command_deadline_cannot_be_extended_by_dripping_bytes() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let peer = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_write_timeout(Some(Duration::from_secs(1))).unwrap();
            // Each byte arrives before the inactivity timeout would expire.
            for _ in 0..40 {
                if socket.write_all(b"x").is_err() { break; }
                std::thread::sleep(Duration::from_millis(25));
            }
        });
        let start = std::time::Instant::now();
        assert!(daemon_command_at(address, "PING", &"a".repeat(64), Duration::from_millis(150)).is_err());
        assert!(start.elapsed() < Duration::from_millis(800));
        peer.join().unwrap();
    }

    #[test]
    fn invalid_filename_bytes_are_not_replaced() {
        assert!(decode_daemon_response(b"{\"path\":\"/sdcard/report\xff\"}".to_vec()).is_err());
        assert_eq!(decode_daemon_response("{\"path\":\"/sdcard/写真\"}\n".as_bytes().to_vec()).unwrap(),
            "{\"path\":\"/sdcard/写真\"}");
    }
}
