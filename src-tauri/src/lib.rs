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
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

// ── Constants ───────────────────────────────────────────────────────────────

const DAEMON_PORT: u16 = 5050;
const DAEMON_ADDR: &str = "127.0.0.1:5050";
const DEVICE_BIN_PATH: &str = "/data/local/tmp/socketsweep_daemon";
const DEVICE_TOKEN_PATH: &str = "/data/local/tmp/socketsweep_token";
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TCP_READ_TIMEOUT: Duration = Duration::from_secs(120); // scans can be slow

/// Tracks the root path of the last successful scan so we can prevent its deletion.
static SCAN_ROOT: Mutex<Option<String>> = Mutex::new(None);

/// Tracks the serial of the connected device so all ADB calls target the right device.
static DEVICE_SERIAL: Mutex<Option<String>> = Mutex::new(None);
static SESSION_TOKEN: Mutex<Option<String>> = Mutex::new(None);
static READ_ONLY: Mutex<bool> = Mutex::new(false);
static DEVICE_PRIVILEGE: Mutex<Privilege> = Mutex::new(Privilege::Shell);
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

fn device_shell(adb_path: &std::path::Path, command: &str) -> Result<String, String> {
    let privilege = *DEVICE_PRIVILEGE.lock().map_err(|_| "Device state is unavailable")?;
    adb_s(adb_path, &["shell", &device_shell_command(privilege, command)])
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
    use std::io::Read;
    use std::time::{Duration, Instant};

    let mut child = Command::new(adb_path)
        .args(args)
        .stdin(if input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to execute adb binary at {:?}: {}", adb_path, e))?;

    let mut stdout_pipe = child.stdout.take().unwrap();
    let mut stderr_pipe = child.stderr.take().unwrap();

    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });

    let stderr_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    if let Some(bytes) = input {
        let result = child.stdin.take().unwrap().write_all(bytes);
        if let Err(e) = result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Failed to provide ADB input: {e}"));
        }
    }

    let timeout_secs = 15;
    let timeout = Duration::from_secs(timeout_secs);
    let start = Instant::now();
    let status;

    loop {
        if let Some(s) = child.try_wait().map_err(|e| format!("Failed to wait on adb process: {}", e))? {
            status = s;
            break;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("ADB command timed out after {} seconds. Please reconnect your device and try again.", timeout_secs));
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let stdout_bytes = stdout_thread.join().unwrap_or_default();
    let stderr_bytes = stderr_thread.join().unwrap_or_default();

    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

    if !status.success() {
        let combined = format!("{stdout} {stderr}").to_lowercase();
        if combined.contains("no devices") || combined.contains("device not found") {
            return Err("No Android device detected. Connect your phone via USB and enable USB Debugging.".into());
        }
        if combined.contains("unauthorized") {
            return Err("USB Debugging not authorised. Check the confirmation dialog on your phone.".into());
        }
        return Err(format!(
            "adb {} failed (exit {}):\n{stderr}",
            args.join(" "),
            status.code().unwrap_or(-1)
        ));
    }

    Ok(stdout)
}

/// Run an ADB command targeting the stored device serial (if any).
/// Prepends `-s <serial>` when a device serial is known.
fn adb_s(adb_path: &std::path::Path, args: &[&str]) -> Result<String, String> {
    if let Ok(guard) = DEVICE_SERIAL.lock() {
        if let Some(ref serial) = *guard {
            let mut full_args = vec!["-s", serial.as_str()];
            full_args.extend_from_slice(args);
            return adb(adb_path, &full_args);
        }
    }
    adb(adb_path, args)
}

// ── TCP helper ──────────────────────────────────────────────────────────────

/// Send a one-line command to the daemon and read the full response.
fn daemon_command(cmd: &str) -> Result<String, String> {
    let token = SESSION_TOKEN.lock().map_err(|_| "Session state is unavailable")?
        .clone().ok_or("No active daemon session. Connect your device first.")?;
    daemon_command_with_token(cmd, &token)
}

fn command_payload(cmd: &str, token: &str) -> Result<String, String> {
    if cmd.is_empty() || cmd.len() > 16 * 1024 || cmd.contains(['\r', '\n', '\0']) {
        return Err("This path cannot be sent safely: it contains a line break or null byte, or is too long.".into());
    }
    Ok(format!("AUTH {token}\n{cmd}\n"))
}

fn daemon_command_with_token(cmd: &str, token: &str) -> Result<String, String> {
    let payload = command_payload(cmd, token)?;
    let mut stream = TcpStream::connect_timeout(
        &DAEMON_ADDR.parse().unwrap(),
        TCP_CONNECT_TIMEOUT,
    )
    .map_err(|e| format!("Cannot connect to daemon at {DAEMON_ADDR}: {e}"))?;

    stream
        .set_read_timeout(Some(TCP_READ_TIMEOUT))
        .map_err(|e| format!("Failed to set read timeout: {e}"))?;
    stream.set_write_timeout(Some(TCP_CONNECT_TIMEOUT))
        .map_err(|e| format!("Failed to set write timeout: {e}"))?;
    stream
        .write_all(payload.as_bytes())
        .map_err(|e| format!("Failed to send command to daemon: {e}"))?;

    let mut response_bytes = Vec::with_capacity(1024 * 1024);
    stream
        .read_to_end(&mut response_bytes)
        .map_err(|e| format!("Failed to read daemon response: {e}"))?;

    decode_daemon_response(response_bytes)
}

fn decode_daemon_response(bytes: Vec<u8>) -> Result<String, String> {
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

fn new_session_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Failed to create daemon session: {e}"))?;
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
    let has_session = DEVICE_SERIAL.lock().map_err(|_| "Device state is unavailable")?.is_some();
    if has_session {
        stop_daemon_inner(&app)?;
    }
    *SESSION_TOKEN.lock().map_err(|_| "Session state is unavailable")? = None;
    *SCAN_ROOT.lock().map_err(|_| "Scan state is unavailable")? = None;
    *DEVICE_SERIAL.lock().map_err(|_| "Device state is unavailable")? = None;
    *READ_ONLY.lock().map_err(|_| "Session state is unavailable")? = false;
    *DEVICE_PRIVILEGE.lock().map_err(|_| "Device state is unavailable")? = Privilege::Shell;
    let result = init_daemon_inner(app.clone(), root_mode.unwrap_or(false));
    if result.is_err() {
        // A failed push/start/handshake must not leave a live daemon or a
        // startup secret behind. Only target the device selected by this init.
        let has_device = DEVICE_SERIAL.lock().map_err(|_| "Device state is unavailable")?.is_some();
        if has_device {
            if let Ok(adb_path) = get_bundled_binary(&app, "adb") {
                let _ = device_shell(&adb_path, "pkill -f '[s]ocketsweep_daemon' || true");
                let _ = adb_s(&adb_path, &["forward", "--remove", &format!("tcp:{DAEMON_PORT}")]);
                let _ = adb_s(&adb_path, &["shell", "rm", "-f", DEVICE_TOKEN_PATH]);
            }
        }
        *DEVICE_SERIAL.lock().map_err(|_| "Device state is unavailable")? = None;
        *DEVICE_PRIVILEGE.lock().map_err(|_| "Device state is unavailable")? = Privilege::Shell;
    }
    result
}

fn init_daemon_inner(app: tauri::AppHandle, root_mode: bool) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let daemon_src = get_bundled_binary(&app, "daemon")?;

    // 1 — Verify ADB is reachable and a device is connected.
    adb(&adb_path, &["version"])?;
    let devices = adb(&adb_path, &["devices"])?;
    let device_line = devices
        .lines()
        .find(|l| l.ends_with("\tdevice") && !l.starts_with("List"));

    let serial = match device_line {
        Some(line) => line.split('\t').next().unwrap_or("").trim().to_string(),
        None => {
            // Check for unauthorized devices to give a better error.
            if devices.lines().any(|l| l.contains("unauthorized")) {
                return Err("USB Debugging not authorised. Check the confirmation dialog on your phone.".into());
            }
            return Err(
                "No Android device detected. Connect your phone via USB and enable USB Debugging.".into(),
            );
        }
    };

    // Store the serial so all subsequent ADB calls (including stop_daemon) target this device.
    if let Ok(mut guard) = DEVICE_SERIAL.lock() {
        *guard = Some(serial);
    }

    let privilege = select_privilege(root_mode, |args| adb_s(&adb_path, args))?;
    *DEVICE_PRIVILEGE.lock().map_err(|_| "Device state is unavailable")? = privilege;

    // 2 — Kill any zombie daemon before we push/start.
    device_shell(&adb_path, "pkill -f '[s]ocketsweep_daemon' || true")?;
    std::thread::sleep(Duration::from_millis(300));

    // Transfer the fresh secret over stdin into a shell-owned file. Neither
    // the startup arguments nor the frontend response contain the secret.
    let token = new_session_token()?;
    let serial = DEVICE_SERIAL.lock().map_err(|_| "Device state is unavailable")?
        .clone().ok_or("No connected device")?;
    let token_cmd = format!("rm -f {DEVICE_TOKEN_PATH} && umask 077 && cat > {DEVICE_TOKEN_PATH}");
    adb_with_input(&adb_path, &["-s", &serial, "shell", &token_cmd], Some(format!("{token}\n").as_bytes()))?;

    // 2.5 — Automate MANAGE_EXTERNAL_STORAGE permission for the shell user.
    let _ = adb_s(&adb_path, &["shell", "appops set com.android.shell MANAGE_EXTERNAL_STORAGE allow"]);

    // 4 — Push binary to device.
    adb_s(&adb_path, &["push", &daemon_src.to_string_lossy(), DEVICE_BIN_PATH])?;

    // 5 — Make it executable.
    adb_s(&adb_path, &["shell", "chmod", "+x", DEVICE_BIN_PATH])?;

    // 6 — Start the daemon in the background on the device.
    let mode_arg = if root_mode { " --read-only" } else { "" };
    let start_cmd = format!("nohup {DEVICE_BIN_PATH} {DAEMON_PORT} {DEVICE_TOKEN_PATH}{mode_arg} > /dev/null 2>&1 & echo $!; exit");
    let pid_output = device_shell(&adb_path, &start_cmd)?;
    let pid: u32 = pid_output.trim().parse().map_err(|_| "Daemon launch did not return a process ID")?;

    // 7 — Set up the USB TCP tunnel.
    adb_s(&adb_path, &["forward", &format!("tcp:{DAEMON_PORT}"), &format!("tcp:{DAEMON_PORT}")])?;

    // 8 — Ping-Retry loop.
    let mut pong = String::new();
    let mut connected_daemon = false;
    let mut handshake_error = String::new();
    for _ in 0..15 {
        std::thread::sleep(Duration::from_millis(150));
        match daemon_command_with_token("PING", &token).and_then(|res| {
            require_handshake(&res, root_mode)?;
            Ok(res)
        }) {
            Ok(res) => {
                pong = res;
                connected_daemon = true;
                break;
            }
            Err(error) => {
                handshake_error = error;
                continue;
            }
        }
    }

    if !connected_daemon {
        return Err(format!("Daemon did not complete the authenticated handshake: {handshake_error}"));
    }

    *SESSION_TOKEN.lock().map_err(|_| "Session state is unavailable")? = Some(token);
    *READ_ONLY.lock().map_err(|_| "Session state is unavailable")? = require_handshake(&pong, root_mode)?.read_only.unwrap();

    Ok(format!(
        "{{\"daemon_pid\":\"{pid}\",\"ping_response\":{pong}}}"
    ))
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
    *SCAN_ROOT.lock().map_err(|_| "Scan state is unavailable")? = None;
    let effective_root = path
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "/sdcard".into());
    let token = SESSION_TOKEN
        .lock()
        .map_err(|_| "Session state is unavailable")?
        .clone()
        .ok_or("No active daemon session. Connect your device first.")?;
    let payload = command_payload(&format!("SCAN_STREAM {effective_root}"), &token)?;
    let read_only = *READ_ONLY
        .lock()
        .map_err(|_| "Session state is unavailable")?;
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
            TcpStream::connect_timeout(&DAEMON_ADDR.parse().unwrap(), TCP_CONNECT_TIMEOUT)
                .map_err(|e| format!("Cannot connect to daemon at {DAEMON_ADDR}: {e}"))?;
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
        let json = response.json()?;
        // Serialize before authorization too: a result exceeding the UI limit
        // must not leave a bridge deletion root behind.
        let mut active = ACTIVE_SCAN
            .lock()
            .map_err(|_| "Scan state is unavailable")?;
        if cancelled.load(Ordering::SeqCst) {
            return Err("Scan cancelled".into());
        }
        *SCAN_ROOT.lock().map_err(|_| "Scan state is unavailable")? =
            Some(response.root().to_string());
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
fn stop_daemon(app: tauri::AppHandle) -> Result<String, String> {
    let _operation = DAEMON_OPERATION.lock().map_err(|_| "Daemon state is unavailable")?;
    stop_daemon_inner(&app)
}

fn stop_daemon_inner(app: &tauri::AppHandle) -> Result<String, String> {
    let adb_path = get_bundled_binary(app, "adb")?;
    let response = daemon_command("SHUTDOWN");
    let has_device = DEVICE_SERIAL.lock().map_err(|_| "Device state is unavailable")?.is_some();
    if has_device {
        if response.is_err() {
            let _ = device_shell(&adb_path, "pkill -f '[s]ocketsweep_daemon' || true");
        }
        let _ = adb_s(&adb_path, &["forward", "--remove", &format!("tcp:{DAEMON_PORT}")]);
        let _ = adb_s(&adb_path, &["shell", "rm", "-f", DEVICE_BIN_PATH, DEVICE_TOKEN_PATH]);
    }
    *SESSION_TOKEN.lock().map_err(|_| "Session state is unavailable")? = None;
    *SCAN_ROOT.lock().map_err(|_| "Scan state is unavailable")? = None;
    *DEVICE_SERIAL.lock().map_err(|_| "Device state is unavailable")? = None;
    *DEVICE_PRIVILEGE.lock().map_err(|_| "Device state is unavailable")? = Privilege::Shell;
    *READ_ONLY.lock().map_err(|_| "Session state is unavailable")? = false;
    Ok(response.unwrap_or_else(|_| "daemon already stopped".into()))
}

#[tauri::command(async)]
fn delete_item(path: String) -> Result<String, String> {
    let _operation = DAEMON_OPERATION.lock().map_err(|_| "Daemon state is unavailable")?;
    if *READ_ONLY.lock().map_err(|_| "Session state is unavailable")? {
        return Err("Root scans are read-only; deletion is disabled.".into());
    }
    // Prevent deletion of the scan root directory.
    let root = SCAN_ROOT.lock().map_err(|_| "Scan state is unavailable")?;
    match root.as_ref() {
        Some(scan_root) if path == *scan_root => {
            return Err("Cannot delete the scan root directory.".into());
        }
        None => return Err("Scan your device before deleting files.".into()),
        _ => {}
    }
    drop(root);
    daemon_command(&format!("DELETE {path}"))
}

// ── Tauri entry point ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            check_adb,
            init_daemon,
            run_scan,
            cancel_scan,
            acknowledge_scan_progress,
            ping_daemon,
            stop_daemon,
            delete_item,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
    fn session_tokens_are_fresh_and_have_full_entropy() {
        let first = new_session_token().unwrap();
        let second = new_session_token().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(first, second);
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
    fn invalid_filename_bytes_are_not_replaced() {
        assert!(decode_daemon_response(b"{\"path\":\"/sdcard/report\xff\"}".to_vec()).is_err());
        assert_eq!(decode_daemon_response("{\"path\":\"/sdcard/写真\"}\n".as_bytes().to_vec()).unwrap(),
            "{\"path\":\"/sdcard/写真\"}");
    }
}
