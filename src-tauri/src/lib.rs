// ============================================================================
// lib.rs — SocketSweep Tauri Bridge (Phase 2)
// ============================================================================
// Orchestrates the C++ Android daemon via ADB and communicates with it
// over a TCP tunnel.  All commands return Result<String, String> so the
// React frontend can display meaningful error messages.
//
// Wire protocol (matches Phase 1 daemon):
//   → "PING\n"              ← {"status":"ok","message":"pong"}
//   → "SCAN [path]\n"       ← {"status":"ok","scan_time_ms":…,"tree":{…}}
//   → "SHUTDOWN\n"          ← {"status":"ok","message":"shutting down"}
// ============================================================================

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::Command;
use std::time::Duration;

// ── Constants ───────────────────────────────────────────────────────────────

const DAEMON_PORT: u16 = 5050;
const DAEMON_ADDR: &str = "127.0.0.1:5050";
const DEVICE_BIN_PATH: &str = "/data/local/tmp/socketsweep_daemon";
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TCP_READ_TIMEOUT: Duration = Duration::from_secs(120); // scans can be slow

// ── Resource Resolution ─────────────────────────────────────────────────────

use tauri::Manager;

fn get_bundled_binary(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| format!("Failed to get resource dir: {}", e))?;
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
    let output = Command::new(adb_path)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute adb binary at {:?}: {}", adb_path, e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
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
            output.status.code().unwrap_or(-1)
        ));
    }

    Ok(stdout)
}

// ── TCP helper ──────────────────────────────────────────────────────────────

/// Send a one-line command to the daemon and read the full response.
fn daemon_command(cmd: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect_timeout(
        &DAEMON_ADDR.parse().unwrap(),
        TCP_CONNECT_TIMEOUT,
    )
    .map_err(|e| format!("Cannot connect to daemon at {DAEMON_ADDR}: {e}"))?;

    stream
        .set_read_timeout(Some(TCP_READ_TIMEOUT))
        .map_err(|e| format!("Failed to set read timeout: {e}"))?;

    let payload = if cmd.ends_with('\n') {
        cmd.to_string()
    } else {
        format!("{cmd}\n")
    };
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

// ── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn check_adb(app: tauri::AppHandle) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let version = adb(&adb_path, &["version"])?;
    let first_line = version.lines().next().unwrap_or("unknown").to_string();
    Ok(first_line)
}

#[tauri::command]
fn init_daemon(app: tauri::AppHandle) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let daemon_src = get_bundled_binary(&app, "daemon")?;

    // 1 — Verify ADB is reachable and a device is connected.
    adb(&adb_path, &["version"])?;
    let devices = adb(&adb_path, &["devices"])?;
    let connected = devices
        .lines()
        .filter(|l| l.contains("device") && !l.starts_with("List"))
        .count();
    if connected == 0 {
        return Err(
            "No Android device detected. Connect your phone via USB and enable USB Debugging.".into(),
        );
    }

    // 2 — Kill any zombie daemon before we push/start.
    let _ = adb(&adb_path, &["shell", "pkill -f socketsweep_daemon || true"]);

    // 2.5 — Automate MANAGE_EXTERNAL_STORAGE permission for the shell user.
    let _ = adb(&adb_path, &["shell", "appops set com.android.shell MANAGE_EXTERNAL_STORAGE allow"]);

    // 4 — Push binary to device.
    adb(&adb_path, &["push", &daemon_src.to_string_lossy(), DEVICE_BIN_PATH])?;

    // 5 — Make it executable.
    adb(&adb_path, &["shell", "chmod", "+x", DEVICE_BIN_PATH])?;

    // 5 — Kill any previously running instance (ignore errors).
    let _ = adb(&adb_path, &["shell", "pkill", "-f", "socketsweep_daemon"]);
    std::thread::sleep(Duration::from_millis(300));

    // 6 — Start the daemon in the background on the device.
    let start_cmd = format!("nohup {DEVICE_BIN_PATH} > /dev/null 2>&1 & echo $!; exit");
    let pid_output = adb(&adb_path, &["shell", &start_cmd])?;
    let pid = pid_output.trim().to_string();

    // 7 — Set up the USB TCP tunnel.
    adb(&adb_path, &["forward", &format!("tcp:{DAEMON_PORT}"), &format!("tcp:{DAEMON_PORT}")])?;

    // 8 — Ping-Retry loop.
    let mut pong = String::new();
    let mut connected_daemon = false;
    for _ in 0..15 {
        std::thread::sleep(Duration::from_millis(150));
        match daemon_command("PING") {
            Ok(res) => {
                pong = res;
                connected_daemon = true;
                break;
            }
            Err(_) => continue,
        }
    }

    if !connected_daemon {
        return Err("Daemon started but failed to respond to PING over TCP tunnel.".into());
    }

    Ok(format!(
        "{{\"daemon_pid\":\"{pid}\",\"ping_response\":{pong}}}"
    ))
}

#[tauri::command]
fn run_scan(path: Option<String>) -> Result<String, String> {
    let cmd = match path {
        Some(ref p) if !p.is_empty() => format!("SCAN {p}"),
        _ => "SCAN".to_string(),
    };
    daemon_command(&cmd)
}

#[tauri::command]
fn ping_daemon() -> Result<String, String> {
    daemon_command("PING")
}

#[tauri::command]
fn stop_daemon(app: tauri::AppHandle) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let response = daemon_command("SHUTDOWN").unwrap_or_else(|_| "daemon already stopped".into());
    let _ = adb(&adb_path, &["forward", "--remove", &format!("tcp:{DAEMON_PORT}")]);
    let _ = adb(&adb_path, &["shell", "rm", DEVICE_BIN_PATH]);
    Ok(response)
}

#[tauri::command]
fn delete_item(path: String) -> Result<String, String> {
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
