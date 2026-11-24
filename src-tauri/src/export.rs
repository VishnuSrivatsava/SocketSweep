//! Safe single-file export (docs/file-transfer.md, "Safe first application
//! export"). One regular file per operation, transferred by an authenticated
//! daemon `READ` over the session's existing forward — never `adb pull`, whose
//! symlink-following open cannot satisfy the documented source policy.
//!
//! Ordering: destination authority (dialog) → fresh-destination check →
//! session/scope recheck → transfer into an exclusive `.part` file on the
//! destination filesystem → size verification → session/scope recheck →
//! platform no-clobber rename (the commit point). Failures before the commit
//! remove only this operation's `.part` file; the scan snapshot is never
//! quarantined because the transfer is read-only.

use crate::session;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const EXPORT_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// No payload byte for this long means the device went away mid-transfer.
const EXPORT_IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const EXPORT_TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
const EXPORT_CHUNK_BYTES: usize = 64 * 1024;
/// The header line is small; anything longer is a protocol violation.
const MAX_EXPORT_HEADER_BYTES: usize = 4 * 1024;

/// Prepared under the store lock; the transfer re-checks both bindings at the
/// documented points instead of holding the operation lock for the whole flow.
#[derive(Clone)]
pub(crate) struct SessionBinding {
    pub token: String,
    pub serial: String,
    pub address: std::net::SocketAddr,
    pub read_only: bool,
}

#[derive(Serialize)]
pub(crate) struct ExportProgress {
    pub export_id: String,
    pub stage: &'static str,
    pub bytes_copied: u64,
    pub total_bytes: u64,
}

#[derive(Deserialize)]
struct ReadHeader {
    status: String,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    uid: Option<u32>,
    #[serde(default)]
    read_only: Option<bool>,
}

/// Registry entry for the in-flight export. `cancel_export` bypasses every
/// other lock, so a late click can never cancel a newer export, and the
/// socket shutdown unblocks a parked read immediately.
pub(crate) struct ActiveExport {
    pub id: String,
    pub cancelled: std::sync::Arc<AtomicBool>,
    pub progress_pending: std::sync::Arc<AtomicBool>,
    pub socket: Option<TcpStream>,
}

/// Removes only this operation's staging file on every path out of the
/// transfer, including panics. A successful rename leaves nothing to remove.
struct PartFile(PathBuf);

impl PartFile {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(crate) fn validate_export_id(export_id: &str) -> Result<(), String> {
    if export_id.is_empty()
        || export_id.len() > 64
        || !export_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid export identifier".into());
    }
    Ok(())
}

/// A conservative save-dialog filter from the suggested file extension.
/// Only plain alphanumeric extensions are offered; everything else gets an
/// unfiltered picker.
pub(crate) fn extension_filter(name: &str) -> Option<(String, Vec<String>)> {
    let extension = Path::new(name).extension()?.to_str()?;
    if extension.is_empty()
        || extension.len() > 16
        || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(("Files".into(), vec![extension.to_ascii_lowercase()]))
}

/// The dialog result is a filesystem path; URI results (mobile content
/// providers) are not reachable on the desktop hosts this feature targets.
pub(crate) fn destination_path(
    file_path: tauri_plugin_dialog::FilePath,
) -> Result<PathBuf, String> {
    file_path
        .into_path()
        .map_err(|error| format!("Cannot resolve the chosen destination: {error}"))
}

/// The user's chosen destination must be a fresh name in an existing
/// directory. `lstat` never follows the final component, so a pre-existing
/// symlink is rejected exactly like an existing file.
pub(crate) fn validate_destination(destination: &Path) -> Result<(), String> {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Choose a valid file name for the export destination.")?;
    if name == "." || name == ".." || name.contains('\0') {
        return Err("Choose a valid file name for the export destination.".into());
    }
    match std::fs::symlink_metadata(destination) {
        Ok(_) => Err("Destination already exists; choose a fresh name. Export never overwrites files.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot check the export destination: {error}")),
    }
}

/// Both bindings must still hold at every documented recheck point. The
/// session token is unique per `Session::start`, so token equality identifies
/// the same session instance; scope equality identifies the same snapshot.
pub(crate) fn binding_matches(
    current: Option<&session::Connection>,
    binding: &SessionBinding,
) -> Result<(), String> {
    let current = current
        .ok_or("The device session ended; reconnect and retry the export.")?;
    if current.token != binding.token {
        return Err("The device session changed; reconnect and retry the export.".into());
    }
    if current.read_only != binding.read_only {
        return Err("The device session changed; reconnect and retry the export.".into());
    }
    Ok(())
}

type ProgressSink<'a> = &'a dyn Fn(ExportProgress) -> Result<(), String>;

fn progress_stage(
    cancelled: &AtomicBool,
    progress_pending: &AtomicBool,
    send: ProgressSink<'_>,
    export_id: &str,
    stage: &'static str,
    bytes_copied: u64,
    total_bytes: u64,
) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("Export cancelled".into());
    }
    // At most one progress message may await acknowledgement; coalesce the
    // rest so a slow webview cannot grow an unbounded IPC queue.
    if progress_pending
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }
    send(ExportProgress {
        export_id: export_id.to_string(),
        stage,
        bytes_copied,
        total_bytes,
    })
    .map_err(|e| format!("Cannot deliver export progress: {e}"))
}

/// Receive the newline-terminated header line under the idle timeout.
fn read_header(stream: &mut TcpStream, deadline: Instant) -> Result<ReadHeader, String> {
    let mut line = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        if Instant::now() >= deadline {
            return Err("Device connection lost. Reconnect and retry.".into());
        }
        stream
            .set_read_timeout(Some(EXPORT_IDLE_TIMEOUT))
            .map_err(|e| e.to_string())?;
        match stream.read(&mut byte) {
            Ok(0) => return Err("Device connection lost. Reconnect and retry.".into()),
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                line.push(byte[0]);
                if line.len() > MAX_EXPORT_HEADER_BYTES {
                    return Err("Daemon returned an invalid export response".into());
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                return Err("Device connection lost. Reconnect and retry.".into())
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Device connection lost. Reconnect and retry.".into()),
        }
    }
    serde_json::from_slice(&line).map_err(|_| "Daemon returned an invalid export response".into())
}

fn map_read_error(header: &ReadHeader) -> String {
    match header.code.as_deref() {
        Some("source_unavailable") => {
            "The source is no longer the scanned file; rescan and retry.".into()
        }
        Some("export_disabled") => {
            "Export is unavailable in read-only root sessions; scan in normal mode instead.".into()
        }
        Some("scan_root_changed") | Some("no_scan_root") | Some("invalid_path") => {
            "Export is no longer available for this scan; rescan and retry.".into()
        }
        _ => header
            .message
            .clone()
            .unwrap_or_else(|| "Export failed; rescan and retry.".into()),
    }
}

/// Authenticated `READ` transfer into `output`. Returns the SHA-256 of the
/// received bytes once exactly `expected_size` bytes arrived.
#[allow(clippy::too_many_arguments)]
fn read_daemon_file(
    address: std::net::SocketAddr,
    payload: &str,
    expected_size: u64,
    session_read_only: bool,
    output: &mut std::fs::File,
    cancelled: &AtomicBool,
    progress_pending: &AtomicBool,
    send: ProgressSink<'_>,
    export_id: &str,
) -> Result<String, String> {
    let deadline = Instant::now() + EXPORT_TOTAL_TIMEOUT;
    if cancelled.load(Ordering::SeqCst) {
        return Err("Export cancelled".into());
    }
    let mut stream = TcpStream::connect_timeout(&address, EXPORT_CONNECT_TIMEOUT)
        .map_err(|_| "Device connection lost. Reconnect and retry.".to_string())?;
    stream
        .set_write_timeout(Some(EXPORT_CONNECT_TIMEOUT))
        .map_err(|e| e.to_string())?;
    {
        // Publish the socket so cancellation can unblock a parked read.
        let mut active = crate::ACTIVE_EXPORT
            .lock()
            .map_err(|_| "Export state is unavailable")?;
        if cancelled.load(Ordering::SeqCst) {
            return Err("Export cancelled".into());
        }
        if let Some(active) = active.as_mut().filter(|active| active.id == export_id) {
            active.socket = Some(stream.try_clone().map_err(|e| e.to_string())?);
        }
    }
    stream
        .write_all(payload.as_bytes())
        .map_err(|_| "Device connection lost. Reconnect and retry.".to_string())?;
    let header = read_header(&mut stream, deadline)?;
    if header.status != "ok" {
        return Err(map_read_error(&header));
    }
    // Root identity is established at session start and must never drift.
    if header.read_only != Some(session_read_only)
        || header.uid.map(|uid| uid == 0 && !session_read_only).unwrap_or(true)
    {
        return Err("Daemon identity changed; reconnect and retry.".into());
    }
    let size = header.size.ok_or("Daemon returned an invalid export response")?;
    if size != expected_size {
        return Err("Source changed during export; rescan and retry.".into());
    }

    let mut hasher = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; EXPORT_CHUNK_BYTES];
    while copied < size {
        if Instant::now() >= deadline {
            return Err("Export timed out. Reconnect and retry.".into());
        }
        stream
            .set_read_timeout(Some(EXPORT_IDLE_TIMEOUT))
            .map_err(|e| e.to_string())?;
        let want = usize::try_from(size - copied)
            .unwrap_or(EXPORT_CHUNK_BYTES)
            .min(EXPORT_CHUNK_BYTES);
        let read = match stream.read(&mut buffer[..want]) {
            Ok(0) if cancelled.load(Ordering::SeqCst) => return Err("Export cancelled".into()),
            Ok(0) => return Err("Device connection lost during transfer. Reconnect and retry.".into()),
            Ok(read) => read,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                return Err("Device connection lost. Reconnect and retry.".into())
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Device connection lost. Reconnect and retry.".into()),
        };
        output
            .write_all(&buffer[..read])
            .map_err(|e| format!("Cannot write the export staging file: {e}"))?;
        hasher.update(&buffer[..read]);
        copied += read as u64;
        progress_stage(
            cancelled,
            progress_pending,
            send,
            export_id,
            "transferring",
            copied,
            size,
        )?;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Atomic no-clobber publish. The rename itself refuses an existing target —
/// the check and the publish are one atomic operation, so a file that appears
/// after the picker cannot be silently overwritten.
pub(crate) fn commit_no_clobber(part: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let from = std::ffi::CString::new(part.as_os_str().as_encoded_bytes())
            .map_err(|_| "Choose a valid file name for the export destination.".to_string())?;
        let to = std::ffi::CString::new(destination.as_os_str().as_encoded_bytes())
            .map_err(|_| "Choose a valid file name for the export destination.".to_string())?;
        // Attribute-level cfg: both platform syscalls do not exist on the
        // other OS, so a runtime cfg! check would still fail to compile.
        #[cfg(target_os = "macos")]
        let rc = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(not(target_os = "macos"))]
        let rc = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if rc != 0 {
            return Err(match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::EEXIST) | Some(libc::ENOTEMPTY) => {
                    "A file appeared at the destination; your original file was not modified.".into()
                }
                Some(libc::EXDEV) => {
                    "Destination is on a different filesystem; choose a location beside the file.".into()
                }
                _ => format!(
                    "Cannot publish the export: {}",
                    std::io::Error::last_os_error()
                ),
            });
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = part
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // Omitting MOVEFILE_REPLACE_EXISTING makes an existing destination a
        // failure instead of a silent overwrite.
        let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) };
        if ok == 0 {
            let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            return Err(match error {
                80 /* ERROR_FILE_EXISTS */ | 183 /* ERROR_ALREADY_EXISTS */ => {
                    "A file appeared at the destination; your original file was not modified.".into()
                }
                _ => format!("Cannot publish the export (Windows error {error})"),
            });
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_export(
    destination: PathBuf,
    plan: &crate::scan_store::ExportPlan,
    binding: &SessionBinding,
    export_id: &str,
    cancelled: &AtomicBool,
    progress_pending: &AtomicBool,
    send: ProgressSink<'_>,
    recheck: &dyn Fn() -> Result<(), String>,
) -> Result<String, String> {
    // Client-side echo of the daemon's policy refusal: export eligibility
    // follows the shell-readable shared-storage policy even when the scan
    // itself ran with root access.
    if binding.read_only {
        return Err(
            "Export is unavailable in read-only root sessions; scan in normal mode instead.".into(),
        );
    }
    validate_destination(&destination)?;
    let directory = destination
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or("Choose a destination inside an existing folder.")?;

    // Recheck (b): after the picker, before any staging resource is created.
    recheck()?;

    let part = PartFile(directory.join(format!(".socketsweep-export-{export_id}.part")));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(part.path())
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "Export staging collision; retry the export.".to_string()
            } else {
                format!("Cannot create the export staging file: {error}")
            }
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Cannot restrict the export staging file: {e}"))?;
    }

    let payload = crate::command_payload(&format!("READ {}", plan.path), &binding.token)?;
    let digest = read_daemon_file(
        binding.address,
        &payload,
        plan.size,
        binding.read_only,
        &mut file,
        cancelled,
        progress_pending,
        send,
        export_id,
    )?;
    file.sync_all()
        .map_err(|e| format!("Cannot finalize the export staging file: {e}"))?;
    drop(file);

    progress_stage(
        cancelled,
        progress_pending,
        send,
        export_id,
        "committing",
        plan.size,
        plan.size,
    )?;

    // Recheck (c): immediately before the commit point.
    recheck()?;
    commit_no_clobber(part.path(), &destination)?;
    drop(part); // published: the staging name no longer exists to remove

    #[cfg(unix)]
    let durability = std::fs::File::open(&directory)
        .and_then(|dir| dir.sync_all())
        .err()
        .map(|error| format!("Export saved, but the directory sync failed: {error}"));
    #[cfg(not(unix))]
    let durability: Option<String> = None;

    let result = serde_json::json!({
        "status": "saved",
        "name": destination.file_name().map(|name| name.to_string_lossy()).unwrap_or_default(),
        "path": destination.display().to_string(),
        "size": plan.size,
        "sha256": digest,
        "caveat": durability,
    });
    Ok(result.to_string())
}

fn recheck_bindings(
    plan: &crate::scan_store::ExportPlan,
    binding: &SessionBinding,
) -> Result<(), String> {
    let current = crate::SESSION
        .lock()
        .map_err(|_| "Session state is unavailable")?
        .as_ref()
        .map(|session| session.connection());
    binding_matches(current.as_ref(), binding)?;
    let store = crate::SCAN_STORE
        .lock()
        .map_err(|_| "Scan state is unavailable")?;
    store
        .as_ref()
        .ok_or("Scan is unavailable; rescan required")?
        .require_scope(&plan.generation, plan.revision)
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::Shutdown;
    use std::sync::{Arc, Mutex};
    use std::net::TcpListener;

    fn quiet_progress() -> impl Fn(ExportProgress) -> Result<(), String> {
        |_progress| Ok(())
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("socketsweep-export-{label}-{nanos}"));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn binding() -> SessionBinding {
        SessionBinding {
            token: "0".repeat(64),
            serial: "serial-1".into(),
            address: std::net::SocketAddr::from(([127, 0, 0, 1], 1)),
            read_only: false,
        }
    }

    fn plan(path: &Path, size: u64) -> crate::scan_store::ExportPlan {
        crate::scan_store::ExportPlan {
            generation: "generation-a".into(),
            revision: 0,
            node_id: 3,
            path: path.display().to_string(),
            name: "file.bin".into(),
            size,
        }
    }

    // ── destination validation ────────────────────────────────────────────
    #[test]
    fn fresh_destination_is_required_and_symlinks_count_as_existing() {
        let directory = temp_dir("destination");
        let destination = directory.join("fresh.bin");
        validate_destination(&destination).unwrap();

        std::fs::write(&destination, b"existing").unwrap();
        let error = validate_destination(&destination).unwrap_err();
        assert!(error.contains("never overwrites"), "{error}");

        #[cfg(unix)]
        {
            let link = directory.join("dangling");
            std::os::unix::fs::symlink("/nonexistent/target", &link).unwrap();
            assert!(validate_destination(&link).is_err());
        }
        assert!(validate_destination(&directory.join(".")).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    // ── no-clobber commit ─────────────────────────────────────────────────
    #[test]
    fn commit_refuses_an_existing_target_and_leaves_its_bytes_untouched() {
        let directory = temp_dir("commit");
        let part = directory.join(".part");
        std::fs::write(&part, b"new bytes").unwrap();
        let destination = directory.join("target.bin");
        std::fs::write(&destination, b"original bytes").unwrap();

        let error = commit_no_clobber(&part, &destination).unwrap_err();
        assert!(error.contains("your original file was not modified"), "{error}");
        assert_eq!(std::fs::read(&destination).unwrap(), b"original bytes");

        // The commit point: after removing the collision the same rename publishes.
        std::fs::remove_file(&destination).unwrap();
        commit_no_clobber(&part, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"new bytes");
        assert!(!part.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn commit_into_a_missing_directory_fails_without_side_effects() {
        let directory = temp_dir("commit-missing");
        let part = directory.join(".part");
        std::fs::write(&part, b"x").unwrap();
        let missing = directory.join("no-such-dir").join("target.bin");
        assert!(commit_no_clobber(&part, &missing).is_err());
        assert!(part.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    // ── session binding identity ──────────────────────────────────────────
    fn session_connection(binding: &SessionBinding) -> session::Connection {
        session::Connection::for_test(
            binding.address,
            binding.token.clone(),
            binding.serial.clone(),
            binding.read_only,
        )
    }

    #[test]
    fn binding_matches_requires_the_same_session_instance() {
        let binding = binding();
        binding_matches(Some(&session_connection(&binding)), &binding).unwrap();

        let mut different = binding.clone();
        different.token = "f".repeat(64);
        let error =
            binding_matches(Some(&session_connection(&different)), &binding).unwrap_err();
        assert!(error.contains("session changed"), "{error}");

        let mut mode = binding.clone();
        mode.read_only = !mode.read_only;
        assert!(binding_matches(Some(&session_connection(&mode)), &binding).is_err());

        let error = binding_matches(None, &binding).unwrap_err();
        assert!(error.contains("session ended"), "{error}");
    }

    // ── error mapping ─────────────────────────────────────────────────────
    #[test]
    fn daemon_error_codes_map_to_actionable_messages() {
        let header = |code: &str| ReadHeader {
            status: "error".into(),
            code: Some(code.into()),
            message: Some("ignored detail".into()),
            size: None,
            uid: None,
            read_only: None,
        };
        assert!(
            map_read_error(&header("source_unavailable")).contains("no longer the scanned file")
        );
        assert!(map_read_error(&header("scan_root_changed")).contains("rescan and retry"));
        assert!(map_read_error(&header("export_disabled")).contains("read-only"));
        assert!(map_read_error(&header("unexpected")).contains("ignored detail"));
    }

    // ── transfer against a fake daemon ────────────────────────────────────
    fn fake_daemon(mode: &'static str, payload: Vec<u8>) -> std::net::SocketAddr {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut byte = [0_u8; 1];
            let mut newlines = 0;
            while newlines < 2 {
                if stream.read(&mut byte).unwrap_or(0) == 0 {
                    return;
                }
                if byte[0] == b'\n' {
                    newlines += 1;
                }
            }
            match mode {
                "auth_fail" => {
                    let _ = stream.write_all(
                        b"{\"status\":\"error\",\"message\":\"Authentication failed\"}\n",
                    );
                }
                "source_unavailable" => {
                    let _ = stream.write_all(b"{\"status\":\"error\",\"code\":\"source_unavailable\",\"message\":\"detail\"}\n");
                }
                "mode_mismatch" => {
                    let size = payload.len() as u64;
                    let _ = stream.write_all(
                        format!("{{\"status\":\"ok\",\"size\":{size},\"uid\":2000,\"read_only\":true}}\n")
                            .as_bytes(),
                    );
                    let _ = stream.write_all(&payload);
                }
                "size_mismatch" => {
                    let size = payload.len() as u64 + 1;
                    let _ = stream.write_all(
                        format!("{{\"status\":\"ok\",\"size\":{size},\"uid\":2000,\"read_only\":false}}\n")
                            .as_bytes(),
                    );
                    let _ = stream.write_all(&payload);
                }
                "short" => {
                    let size = payload.len() as u64;
                    let _ = stream.write_all(
                        format!("{{\"status\":\"ok\",\"size\":{size},\"uid\":2000,\"read_only\":false}}\n")
                            .as_bytes(),
                    );
                    // The header promises `size`; deliver short and close so
                    // the receiving side sees the unfulfilled promise.
                    let _ = stream.write_all(&payload[..payload.len() - 3]);
                }
                "stall" => {
                    let size = payload.len() as u64;
                    let _ = stream.write_all(
                        format!("{{\"status\":\"ok\",\"size\":{size},\"uid\":2000,\"read_only\":false}}\n")
                            .as_bytes(),
                    );
                    // Wait for the client to disconnect (cancellation).
                    let mut sink = [0_u8; 16];
                    let _ = stream.read(&mut sink);
                    return;
                }
                _ => {
                    let size = payload.len() as u64;
                    let _ = stream.write_all(
                        format!("{{\"status\":\"ok\",\"size\":{size},\"uid\":2000,\"read_only\":false}}\n")
                            .as_bytes(),
                    );
                    let _ = stream.write_all(&payload);
                }
            }
            let _ = stream.shutdown(Shutdown::Both);
        });
        address
    }

    fn run_transfer(
        address: std::net::SocketAddr,
        expected: u64,
        read_only: bool,
    ) -> Result<String, String> {
        let directory = temp_dir("transfer");
        let part = directory.join(".part");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .unwrap();
        let cancelled = AtomicBool::new(false);
        let pending = AtomicBool::new(false);
        let progress = quiet_progress();
        let result = read_daemon_file(
            address,
            "AUTH a\nREAD b\n",
            expected,
            read_only,
            &mut file,
            &cancelled,
            &pending,
            &progress,
            "export-test-1",
        );
        std::fs::remove_dir_all(directory).unwrap();
        result
    }

    #[test]
    fn transfer_receives_exact_bytes_and_reports_their_hash() {
        let payload: Vec<u8> = (0..100_000_u32).map(|i| (i % 251) as u8).collect();
        let address = fake_daemon("ok", payload.clone());
        let digest = run_transfer(address, payload.len() as u64, false).unwrap();
        let mut expected = Sha256::new();
        expected.update(&payload);
        assert_eq!(digest, format!("{:x}", expected.finalize()));
    }

    #[test]
    fn transfer_maps_daemon_failures_to_documented_messages() {
        let payload = b"payload".to_vec();
        let auth = run_transfer(fake_daemon("auth_fail", payload.clone()), 7, false).unwrap_err();
        assert!(auth.contains("Authentication failed"), "{auth}");
        let source =
            run_transfer(fake_daemon("source_unavailable", payload.clone()), 7, false).unwrap_err();
        assert!(source.contains("no longer the scanned file"), "{source}");
        let mode = run_transfer(fake_daemon("mode_mismatch", payload.clone()), 7, false).unwrap_err();
        assert!(mode.contains("Daemon identity changed"), "{mode}");
        let size = run_transfer(fake_daemon("size_mismatch", payload.clone()), 7, false).unwrap_err();
        assert!(size.contains("Source changed during export"), "{size}");
        let short = run_transfer(fake_daemon("short", payload), 7, false).unwrap_err();
        assert!(short.contains("connection lost during transfer"), "{short}");
    }

    #[test]
    fn cancelled_transfer_reports_cancellation() {
        // Registry-touching tests share the global single-export registry.
        static SERIAL: Mutex<()> = Mutex::new(());
        let _serial = SERIAL.lock().unwrap();

        let payload = b"payload".to_vec();
        let address = fake_daemon("stall", payload);
        let directory = temp_dir("cancel");
        let part = directory.join(".part");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .unwrap();
        *crate::ACTIVE_EXPORT.lock().unwrap() = Some(ActiveExport {
            id: "export-cancel-1".into(),
            cancelled: Arc::new(AtomicBool::new(false)),
            progress_pending: Arc::new(AtomicBool::new(false)),
            socket: None,
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        let pending = Arc::new(AtomicBool::new(false));
        let progress = quiet_progress();
        let handle = std::thread::spawn({
            let cancelled = cancelled.clone();
            let pending = pending.clone();
            move || {
                read_daemon_file(
                    address,
                    "AUTH a\nREAD b\n",
                    7,
                    false,
                    &mut file,
                    &cancelled,
                    &pending,
                    &progress,
                    "export-cancel-1",
                )
            }
        });
        // Wait until the engine published its socket, then cancel exactly like
        // the cancel_export command would.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut registered = false;
        while std::time::Instant::now() < deadline {
            registered = crate::ACTIVE_EXPORT.lock().unwrap().as_ref().is_some_and(
                |active| active.id == "export-cancel-1" && active.socket.is_some(),
            );
            if registered {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(registered, "engine never registered its socket");
        cancelled.store(true, Ordering::SeqCst);
        if let Some(active) = crate::ACTIVE_EXPORT.lock().unwrap().as_mut() {
            if active.id == "export-cancel-1" {
                if let Some(socket) = active.socket.take() {
                    let _ = socket.shutdown(Shutdown::Both);
                }
            }
        }
        let error = handle.join().unwrap().unwrap_err();
        assert_eq!(error, "Export cancelled");
        *crate::ACTIVE_EXPORT.lock().unwrap() = None;
        std::fs::remove_dir_all(directory).unwrap();
    }

    // ── full flow ─────────────────────────────────────────────────────────
    #[test]
    fn export_flow_stage_writes_and_commits_without_overwrite() {
        let payload: Vec<u8> = (0..50_000_u32).map(|i| (i % 256) as u8).collect();
        let address = fake_daemon("ok", payload.clone());
        let directory = temp_dir("flow");
        let destination = directory.join("exported.bin");
        let test_plan = plan(&destination, payload.len() as u64);
        let mut binding = binding();
        binding.address = address;
        let cancelled = AtomicBool::new(false);
        let pending = AtomicBool::new(false);
        let progress = quiet_progress();
        let result = run_export(
            destination.clone(),
            &test_plan,
            &binding,
            "export-flow-1",
            &cancelled,
            &pending,
            &progress,
            &|| Ok(()),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["status"], "saved");
        assert_eq!(parsed["size"], payload.len() as u64);
        let mut expected = Sha256::new();
        expected.update(&payload);
        assert_eq!(parsed["sha256"], format!("{:x}", expected.finalize()));
        assert_eq!(std::fs::read(&destination).unwrap(), payload);
        // No staging leftovers beside the destination.
        let leftovers: Vec<String> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_recheck_after_the_picker_creates_nothing() {
        let payload = b"x".to_vec();
        let address = fake_daemon("ok", payload);
        let directory = temp_dir("recheck-b");
        let destination = directory.join("out.bin");
        let test_plan = plan(&destination, 1);
        let mut binding = binding();
        binding.address = address;
        let cancelled = AtomicBool::new(false);
        let pending = AtomicBool::new(false);
        let progress = quiet_progress();
        let error = run_export(
            destination.clone(),
            &test_plan,
            &binding,
            "export-recheck-b",
            &cancelled,
            &pending,
            &progress,
            &|| {
                Err("The device session changed; reconnect and retry the export.".into())
            },
        )
        .unwrap_err();
        assert!(error.contains("session changed"), "{error}");
        assert!(!destination.exists());
        // Nothing was staged: the destination name is still fresh.
        validate_destination(&destination).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_recheck_before_commit_discards_the_staging_file() {
        let payload: Vec<u8> = (0..20_000_u32).map(|i| (i % 7) as u8).collect();
        let expected_size = payload.len() as u64;
        let address = fake_daemon("ok", payload);
        let directory = temp_dir("recheck-c");
        let destination = directory.join("out.bin");
        let test_plan = plan(&destination, expected_size);
        let mut binding = binding();
        binding.address = address;
        let cancelled = AtomicBool::new(false);
        let pending = AtomicBool::new(false);
        let progress = quiet_progress();
        let flips = std::sync::atomic::AtomicUsize::new(0);
        let recheck = || {
            let count = flips.fetch_add(1, Ordering::SeqCst);
            if count == 0 {
                Ok(())
            } else {
                Err("The device session ended; reconnect and retry the export.".into())
            }
        };
        let error = run_export(
            destination.clone(),
            &test_plan,
            &binding,
            "export-recheck-c",
            &cancelled,
            &pending,
            &progress,
            &recheck,
        )
        .unwrap_err();
        assert!(error.contains("session ended"), "{error}");
        assert!(!destination.exists());
        let leftovers: Vec<String> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers.len(), 0, "{leftovers:?}");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn run_export_refuses_read_only_sessions_before_touching_the_destination() {
        let destination = temp_dir("export-readonly").join("file.bin");
        let binding = SessionBinding {
            token: "a".repeat(64),
            serial: "serial".into(),
            address: std::net::SocketAddr::from(([127, 0, 0, 1], 1)),
            read_only: true,
        };
        let plan = crate::scan_store::ExportPlan {
            generation: "gen".into(),
            revision: 0,
            node_id: 1,
            path: "/data/app/file.bin".into(),
            name: "file.bin".into(),
            size: 3,
        };
        let cancelled = AtomicBool::new(false);
        let pending = AtomicBool::new(false);
        let error = run_export(
            destination.clone(),
            &plan,
            &binding,
            "export-ro",
            &cancelled,
            &pending,
            &|_: ExportProgress| Ok(()),
            &|| Ok(()),
        )
        .unwrap_err();
        assert!(error.contains("read-only"), "{error}");
        assert!(!destination.exists());
    }

    // ── real daemon: structural confinement ───────────────────────────────
    // The daemon targets Android (POSIX) only; host-compiling it needs a Unix
    // toolchain, so this group mirrors the session tests' cfg gate.
    #[cfg(unix)]
    mod confinement {
        use super::*;

    fn host_daemon() -> PathBuf {
        static COMPILED: std::sync::OnceLock<Result<PathBuf, String>> =
            std::sync::OnceLock::new();
        COMPILED
            .get_or_init(|| {
                let cxx = std::env::var("CXX").unwrap_or_else(|_| "c++".into());
                let source = Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .join("engine/daemon.cpp");
                let binary = temp_dir("daemon-build").join("daemon");
                match std::process::Command::new(cxx)
                    .args(["-std=c++17", "-O2", "-pthread", "-fno-exceptions", "-fno-rtti"])
                    .arg(&source)
                    .arg("-o")
                    .arg(&binary)
                    .status()
                {
                    Ok(status) if status.success() => Ok(binary),
                    Ok(status) => Err(format!("daemon compile failed: {status}")),
                    Err(error) => Err(format!("daemon compile spawn failed: {error}")),
                }
            })
            .clone()
            .unwrap_or_else(|error| panic!("{error}"))
    }

    struct LiveDaemon {
        port: u16,
        directory: PathBuf,
        child: std::process::Child,
        token: String,
    }

    impl Drop for LiveDaemon {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn start_live_daemon() -> LiveDaemon {
        let directory = temp_dir("live-daemon");
        let token = "a".repeat(64);
        std::fs::write(directory.join("token"), format!("{token}\n")).unwrap();
        let ready = directory.join("ready");
        let child = std::process::Command::new(host_daemon())
            .args([
                "0",
                directory.join("token").to_str().unwrap(),
                "--session-ready",
                ready.to_str().unwrap(),
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let announcement = loop {
            if let Ok(text) = std::fs::read_to_string(&ready) {
                break text;
            }
            if std::time::Instant::now() >= deadline {
                panic!("daemon never announced readiness");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        let value: serde_json::Value = serde_json::from_str(announcement.trim()).unwrap();
        LiveDaemon {
            port: value["port"].as_u64().unwrap() as u16,
            directory,
            child,
            token,
        }
    }

    fn daemon_reply(live: &LiveDaemon, command: &str) -> Vec<u8> {
        let mut stream =
            std::net::TcpStream::connect(("127.0.0.1", live.port)).unwrap();
        let payload = format!("AUTH {}\n{command}\n", live.token);
        stream.write_all(payload.as_bytes()).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        response
    }

    fn read_via_daemon(live: &LiveDaemon, path: &str) -> Result<(Vec<u8>, String), String> {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", live.port)).unwrap();
        let payload = format!("AUTH {}\nREAD {path}\n", live.token);
        stream.write_all(payload.as_bytes()).unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new();
        reader.read_line(&mut header).map_err(|e| e.to_string())?;
        let value: serde_json::Value = serde_json::from_str(header.trim())
            .map_err(|_| format!("bad header: {header}"))?;
        if value["status"] != "ok" {
            return Err(format!(
                "{}|{}",
                value["code"].as_str().unwrap_or(""),
                value["message"].as_str().unwrap_or("")
            ));
        }
        let size = value["size"].as_u64().unwrap() as usize;
        let mut content = vec![0_u8; size];
        reader.read_exact(&mut content).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        hasher.update(&content);
        Ok((content, format!("{:x}", hasher.finalize())))
    }

    #[test]
    fn daemon_read_confines_exports_to_regular_files_beneath_the_scan_root() {
        let live = start_live_daemon();
        let tree = live.directory.join("tree");
        std::fs::create_dir_all(tree.join("sub")).unwrap();
        let payload: Vec<u8> = (0..64_000_u32).map(|i| ((i * 7) % 256) as u8).collect();
        std::fs::write(tree.join("sub").join("file.bin"), &payload).unwrap();

        // Pin the scan root exactly like a successful scan does. The stream
        // body carries binary length prefixes, so compare bytes, not UTF-8.
        let scan = daemon_reply(&live, &format!("SCAN_STREAM {}", tree.display()));
        // A successful stream ends with a terminal "done" frame and zero errors.
        let done_marker = b"\"type\":\"done\"";
        assert!(
            scan.windows(done_marker.len()).any(|window| window == done_marker),
            "{}",
            String::from_utf8_lossy(&scan)
        );

        let file_path = tree.join("sub").join("file.bin").display().to_string();
        let (content, digest) = read_via_daemon(&live, &file_path).unwrap();
        assert_eq!(content, payload);
        let mut expected = Sha256::new();
        expected.update(&payload);
        assert_eq!(digest, format!("{:x}", expected.finalize()));

        // A swapped symlink must never redirect the read, even to a readable target.
        std::fs::remove_file(&tree.join("sub").join("file.bin")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hostname", tree.join("sub").join("file.bin")).unwrap();
        #[cfg(not(unix))]
        std::fs::write(&tree.join("sub").join("file.bin"), b"smuggled").unwrap();
        let error = read_via_daemon(&live, &file_path).unwrap_err();
        assert!(error.contains("source_unavailable"), "{error}");

        // Out-of-root, missing, and directory targets fail without reading.
        let outside = read_via_daemon(&live, "/etc/hostname");
        assert!(
            matches!(&outside, Err(message) if message.contains("invalid_path")),
            "{outside:?}"
        );
        let missing = read_via_daemon(&live, &tree.join("gone.bin").display().to_string());
        assert!(
            matches!(&missing, Err(message) if message.contains("source_unavailable")),
            "{missing:?}"
        );
        let directory_reply = read_via_daemon(&live, &tree.join("sub").display().to_string());
        assert!(
            matches!(&directory_reply, Err(message) if message.contains("source_unavailable")),
            "{directory_reply:?}"
        );
    }

    // The assembled engine against the real daemon: real READ framing, real
    // streaming, real staging and commit — no mock in the path.
    #[test]
    fn export_engine_streams_the_real_daemon_into_a_fresh_destination() {
        let live = start_live_daemon();
        let tree = live.directory.join("tree");
        std::fs::create_dir_all(&tree).unwrap();
        let payload: Vec<u8> = (0..131_072_u32).map(|i| ((i * 31) % 256) as u8).collect();
        std::fs::write(tree.join("video.bin"), &payload).unwrap();
        let scan = daemon_reply(&live, &format!("SCAN_STREAM {}", tree.display()));
        let done_marker = b"\"type\":\"done\"";
        assert!(
            scan.windows(done_marker.len()).any(|window| window == done_marker),
            "{}",
            String::from_utf8_lossy(&scan)
        );

        let destination_dir = temp_dir("export-destination");
        let destination = destination_dir.join("video.bin");
        let binding = SessionBinding {
            token: live.token.clone(),
            serial: "test-serial".into(),
            address: std::net::SocketAddr::from(([127, 0, 0, 1], live.port)),
            read_only: false,
        };
        let plan = crate::scan_store::ExportPlan {
            generation: "gen".into(),
            revision: 0,
            node_id: 7,
            path: tree.join("video.bin").display().to_string(),
            name: "video.bin".into(),
            size: payload.len() as u64,
        };
        let cancelled = AtomicBool::new(false);
        let pending = AtomicBool::new(false);
        let stages = std::sync::Mutex::new(Vec::new());
        let result = run_export(
            destination.clone(),
            &plan,
            &binding,
            "export-e2e",
            &cancelled,
            &pending,
            &|progress: ExportProgress| {
                stages.lock().unwrap().push((progress.stage, progress.bytes_copied, progress.total_bytes));
                // The real frontend acks each message (acknowledge_export_progress);
                // mirror that here so coalescing does not swallow later stages.
                pending.store(false, Ordering::SeqCst);
                Ok(())
            },
            &|| Ok(()),
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["status"], "saved");
        assert_eq!(value["name"], "video.bin");
        let mut expected = Sha256::new();
        expected.update(&payload);
        assert_eq!(value["sha256"], format!("{:x}", expected.finalize()));
        assert_eq!(std::fs::read(&destination).unwrap(), payload);
        let stages = stages.into_inner().unwrap();
        assert!(stages.iter().any(|(stage, _, _)| *stage == "transferring"));
        assert!(stages.iter().any(|(stage, _, _)| *stage == "committing"));
        // No staging leftovers beside the published file.
        let leftovers: Vec<String> = std::fs::read_dir(&destination_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["video.bin".to_string()], "{leftovers:?}");
        std::fs::remove_dir_all(&destination_dir).unwrap();
    }
    } // confinement
}
