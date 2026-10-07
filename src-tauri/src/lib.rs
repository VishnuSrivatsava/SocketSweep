// ============================================================================
// lib.rs — SocketSweep Tauri Bridge (Phase 2)
// ============================================================================
// Orchestrates the C++ Android daemon via ADB and communicates with it
// over a TCP tunnel.  All commands return Result<String, String> so the
// React frontend can display meaningful error messages.
//
// Wire protocol (matches Phase 1 daemon):
// Each connection starts with "AUTH <session token>\n", then one command.
//   → "PING\n"              ← {"status":"ok","message":"pong","protocol_version":2}
//   → "SCAN [path]\n"       ← {"status":"ok","scan_time_ms":…,"tree":{…}}
//   → "SHUTDOWN\n"          ← {"status":"ok","message":"shutting down"}
// ============================================================================

use std::io::{Read, Write};
use std::net::TcpStream;
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
// Keep connection changes, scans, and deletes in order across async commands.
static DAEMON_OPERATION: Mutex<()> = Mutex::new(());

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

    let response = String::from_utf8_lossy(&response_bytes).trim().to_string();
    Ok(response)
}

#[derive(serde::Deserialize)]
struct DaemonStatus {
    status: String,
    message: Option<String>,
    protocol_version: Option<u32>,
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
fn init_daemon(app: tauri::AppHandle) -> Result<String, String> {
    let _operation = DAEMON_OPERATION.lock().map_err(|_| "Daemon state is unavailable")?;
    *SESSION_TOKEN.lock().map_err(|_| "Session state is unavailable")? = None;
    *SCAN_ROOT.lock().map_err(|_| "Scan state is unavailable")? = None;
    *DEVICE_SERIAL.lock().map_err(|_| "Device state is unavailable")? = None;
    let result = init_daemon_inner(app.clone());
    if result.is_err() {
        // A failed push/start/handshake must not leave a live daemon or a
        // startup secret behind. Only target the device selected by this init.
        let has_device = DEVICE_SERIAL.lock().map_err(|_| "Device state is unavailable")?.is_some();
        if has_device {
            if let Ok(adb_path) = get_bundled_binary(&app, "adb") {
                let _ = adb_s(&adb_path, &["shell", "pkill -f '[s]ocketsweep_daemon' || true"]);
                let _ = adb_s(&adb_path, &["forward", "--remove", &format!("tcp:{DAEMON_PORT}")]);
                let _ = adb_s(&adb_path, &["shell", "rm", "-f", DEVICE_TOKEN_PATH]);
            }
        }
        *DEVICE_SERIAL.lock().map_err(|_| "Device state is unavailable")? = None;
    }
    result
}

fn init_daemon_inner(app: tauri::AppHandle) -> Result<String, String> {
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

    // 2 — Kill any zombie daemon before we push/start.
    let _ = adb_s(&adb_path, &["shell", "pkill -f '[s]ocketsweep_daemon' || true"]);

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

    // 5 — Kill any previously running instance (ignore errors).
    let _ = adb_s(&adb_path, &["shell", "pkill", "-f", "'[s]ocketsweep_daemon'"]);
    std::thread::sleep(Duration::from_millis(300));

    // 6 — Start the daemon in the background on the device.
    let start_cmd = format!("nohup {DEVICE_BIN_PATH} {DAEMON_PORT} {DEVICE_TOKEN_PATH} > /dev/null 2>&1 & echo $!; exit");
    let pid_output = adb_s(&adb_path, &["shell", &start_cmd])?;
    let pid = pid_output.trim().to_string();

    // 7 — Set up the USB TCP tunnel.
    adb_s(&adb_path, &["forward", &format!("tcp:{DAEMON_PORT}"), &format!("tcp:{DAEMON_PORT}")])?;

    // 8 — Ping-Retry loop.
    let mut pong = String::new();
    let mut connected_daemon = false;
    for _ in 0..15 {
        std::thread::sleep(Duration::from_millis(150));
        match daemon_command_with_token("PING", &token).and_then(|res| {
            let parsed = require_ok(&res)?;
            if parsed.protocol_version != Some(2) {
                return Err("Bundled daemon is outdated. Rebuild it before connecting.".into());
            }
            Ok(res)
        }) {
            Ok(res) => {
                pong = res;
                connected_daemon = true;
                break;
            }
            Err(_) => continue,
        }
    }

    if !connected_daemon {
        return Err("Daemon did not complete the authenticated handshake. Rebuild the bundled daemon and reconnect.".into());
    }

    *SESSION_TOKEN.lock().map_err(|_| "Session state is unavailable")? = Some(token);

    Ok(format!(
        "{{\"daemon_pid\":\"{pid}\",\"ping_response\":{pong}}}"
    ))
}

#[tauri::command(async)]
fn run_scan(path: Option<String>) -> Result<String, String> {
    let _operation = DAEMON_OPERATION.lock().map_err(|_| "Daemon state is unavailable")?;
    let effective_root = match path {
        Some(ref p) if !p.is_empty() => p.clone(),
        _ => "/sdcard".to_string(), // daemon default
    };
    let cmd = format!("SCAN {effective_root}");
    *SCAN_ROOT.lock().map_err(|_| "Scan state is unavailable")? = None;
    let response = daemon_command(&cmd)?;
    require_ok(&response)?;

    // Store the scan root so delete_item can guard against it.
    if let Ok(mut root) = SCAN_ROOT.lock() {
        *root = Some(effective_root);
    }

    Ok(response)
}

#[tauri::command(async)]
fn ping_daemon() -> Result<String, String> {
    let _operation = DAEMON_OPERATION.lock().map_err(|_| "Daemon state is unavailable")?;
    daemon_command("PING")
}

#[tauri::command(async)]
fn stop_daemon(app: tauri::AppHandle) -> Result<String, String> {
    let _operation = DAEMON_OPERATION.lock().map_err(|_| "Daemon state is unavailable")?;
    let adb_path = get_bundled_binary(&app, "adb")?;
    let response = daemon_command("SHUTDOWN").unwrap_or_else(|_| "daemon already stopped".into());
    let _ = adb_s(&adb_path, &["forward", "--remove", &format!("tcp:{DAEMON_PORT}")]);
    let _ = adb_s(&adb_path, &["shell", "rm", "-f", DEVICE_BIN_PATH, DEVICE_TOKEN_PATH]);
    *SESSION_TOKEN.lock().map_err(|_| "Session state is unavailable")? = None;
    *SCAN_ROOT.lock().map_err(|_| "Scan state is unavailable")? = None;
    *DEVICE_SERIAL.lock().map_err(|_| "Device state is unavailable")? = None;
    Ok(response)
}

#[tauri::command(async)]
fn delete_item(path: String) -> Result<String, String> {
    let _operation = DAEMON_OPERATION.lock().map_err(|_| "Daemon state is unavailable")?;
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
}
