//! One connection owns its device files, allocated forward and lifetime child.
//! Teardown never identifies a remote process by a name or reusable PID.
use crate::{
    adb_with_input_timeout, device_shell_command, new_random_id, require_handshake,
    select_privilege, Privilege,
};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(45);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(super) struct Connection {
    pub address: SocketAddr,
    pub token: String,
    pub read_only: bool,
}

pub(super) struct Session {
    adb: PathBuf,
    serial: String,
    directory: String,
    privilege: Privilege,
    owned_directory: bool,
    parent: Option<Child>,
    device_port: Option<u16>,
    local_port: Option<u16>,
    forward_attempted: bool,
    connection: Connection,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    port: u16,
    pid: u32,
}

fn remaining(deadline: Instant) -> Result<Duration, String> {
    let time = deadline.saturating_duration_since(Instant::now());
    if time.is_zero() {
        Err("Session operation timed out".into())
    } else {
        Ok(time)
    }
}

impl Session {
    pub fn connection(&self) -> Connection {
        self.connection.clone()
    }

    fn adb(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        deadline: Instant,
    ) -> Result<String, String> {
        let mut targeted = vec!["-s", self.serial.as_str()];
        targeted.extend_from_slice(args);
        adb_with_input_timeout(
            &self.adb,
            &targeted,
            input,
            remaining(deadline)?.min(Duration::from_secs(15)),
        )
    }

    fn shell(&self, command: &str, deadline: Instant) -> Result<String, String> {
        self.adb(
            &["shell", &device_shell_command(self.privilege, command)],
            None,
            deadline,
        )
    }

    fn new(adb: PathBuf, serial: String) -> Result<Self, String> {
        Ok(Self {
            adb,
            serial,
            directory: format!("/data/local/tmp/socketsweep-{}", new_random_id()?),
            privilege: Privilege::Shell,
            owned_directory: false,
            parent: None,
            device_port: None,
            local_port: None,
            forward_attempted: false,
            connection: Connection {
                address: (Ipv4Addr::LOCALHOST, 0).into(),
                token: new_random_id()?,
                read_only: false,
            },
        })
    }

    #[cfg(test)]
    pub fn test_session() -> Self {
        let mut session = Self::new(PathBuf::from("fixture-adb"), "fixture-device".into()).unwrap();
        session.privilege = Privilege::Su;
        session.connection.read_only = true;
        session
    }

    pub fn start(
        adb: PathBuf,
        daemon: &Path,
        serial: String,
        root_mode: bool,
    ) -> Result<(Self, String), String> {
        let mut session = Self::new(adb, serial)?;
        let result = session.start_inner(daemon, root_mode);
        match result {
            Ok(response) => Ok((session, response)),
            Err(error) => {
                let cleanup = session.cleanup();
                Err(if cleanup.is_empty() {
                    error
                } else {
                    format!(
                        "{error}; session cleanup incomplete: {}",
                        cleanup.join("; ")
                    )
                })
            }
        }
    }

    fn start_inner(&mut self, daemon: &Path, root_mode: bool) -> Result<String, String> {
        let deadline = Instant::now() + START_TIMEOUT;
        if !self
            .adb(&["features"], None, deadline)?
            .trim()
            .split(',')
            .any(|feature| feature == "shell_v2")
        {
            return Err("The connected device must support ADB shell v2 for owned sessions".into());
        }
        self.privilege = select_privilege(root_mode, |args| self.adb(args, None, deadline))?;
        // The directory is shell-owned even for su launches, so adb push can
        // write into it. mkdir must succeed exclusively before cleanup owns it.
        self.adb(
            &["shell", &format!("umask 077 && mkdir '{}'", self.directory)],
            None,
            deadline,
        )?;
        self.owned_directory = true;
        let token_path = format!("{}/token", self.directory);
        self.adb(
            &["shell", &format!("umask 077 && cat > '{token_path}'")],
            Some(format!("{}\n", self.connection.token).as_bytes()),
            deadline,
        )?;
        let _ = self.adb(
            &[
                "shell",
                "appops set com.android.shell MANAGE_EXTERNAL_STORAGE allow",
            ],
            None,
            deadline,
        );
        let executable = format!("{}/daemon", self.directory);
        self.adb(
            &["push", &daemon.to_string_lossy(), &executable],
            None,
            deadline,
        )?;
        self.adb(
            &["shell", &format!("chmod 700 '{executable}'")],
            None,
            deadline,
        )?;
        let ready_path = format!("{}/ready", self.directory);
        let mode = if root_mode { " --read-only" } else { "" };
        let launch = device_shell_command(
            self.privilege,
            &format!("exec '{executable}' 0 '{token_path}' --session-ready '{ready_path}'{mode}"),
        );
        // Raw shell protocol forwards stdin EOF. No nohup, PTY, token argv,
        // inherited terminal input, or unbounded captured daemon diagnostics.
        self.parent = Some(
            Command::new(&self.adb)
                .args(["-s", &self.serial, "shell", "-T", &launch])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Cannot launch session daemon: {e}"))?,
        );
        let ready = loop {
            remaining(deadline)?;
            if self
                .parent
                .as_mut()
                .unwrap()
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err("Daemon exited before announcing its endpoint. Rebuild the bundled daemon and check root access.".into());
            }
            let text = self.shell(
                &format!("if [ -f '{ready_path}' ]; then cat '{ready_path}'; fi"),
                deadline,
            )?;
            if !text.trim().is_empty() {
                let ready: Ready = serde_json::from_str(&text)
                    .map_err(|_| "Invalid daemon session announcement")?;
                if ready.port == 0 || ready.pid < 2 {
                    return Err("Invalid daemon session endpoint".into());
                }
                break ready;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        self.device_port = Some(ready.port);
        self.forward_attempted = true;
        let remote = format!("tcp:{}", ready.port);
        let local = self.adb(
            &["forward", "--no-rebind", "tcp:0", &remote],
            None,
            deadline,
        )?;
        let port = local
            .trim()
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or("ADB did not return its allocated forwarding port")?;
        self.local_port = Some(port);
        self.connection.address.set_port(port);
        // The secret authenticates the exact listener; port/PID metadata alone
        // never confers deletion authority or permits process termination.
        let pong = crate::daemon_command_at(
            self.connection.address,
            "PING",
            &self.connection.token,
            remaining(deadline)?.min(Duration::from_secs(5)),
        )?;
        self.connection.read_only = require_handshake(&pong, root_mode)?.read_only.unwrap();
        Ok(format!(
            "{{\"daemon_pid\":\"{}\",\"ping_response\":{pong}}}",
            ready.pid
        ))
    }

    pub fn cleanup(&mut self) -> Vec<String> {
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        let mut errors = Vec::new();
        // A lost allocation reply does not identify the local listener. Never
        // guess which entry belongs to us from its remote port alone.
        if self.forward_attempted {
            self.forward_attempted = false;
            if let (Some(local), Some(remote)) = (self.local_port, self.device_port) {
                match self.adb(&["forward", "--list"], None, deadline) {
                    Ok(list) => {
                        for local in owned_forwards(&list, &self.serial, local, remote) {
                            if let Err(error) =
                                self.adb(&["forward", "--remove", &local], None, deadline)
                            {
                                errors.push(error);
                            }
                        }
                    }
                    Err(error) => errors.push(error),
                }
            } else {
                errors.push(
                    "ADB did not confirm the allocated forward; an unused local forward may remain"
                        .into(),
                );
            }
        }
        if let Some(mut child) = self.parent.take() {
            drop(child.stdin.take()); // authenticated lifetime ownership, not a remote PID kill
            let until = Instant::now() + Duration::from_millis(250);
            while matches!(child.try_wait(), Ok(None)) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(10));
            }
            if !matches!(child.try_wait(), Ok(Some(_))) {
                let _ = child.kill(); // only our unreaped host child
                let _ = child.wait();
            }
        }
        if self.owned_directory {
            self.owned_directory = false;
            // No recursive delete and no shared legacy paths. Unknown extra
            // files make rmdir fail instead of broadening deletion authority.
            let dir = &self.directory;
            let command = format!("[ ! -L '{dir}' ] && rm -f '{dir}/token' '{dir}/ready' '{dir}/ready.tmp' '{dir}/daemon' && rmdir '{dir}'");
            if let Err(error) = self.shell(&command, deadline) {
                errors.push(error);
            }
        }
        errors
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        for error in self.cleanup() {
            eprintln!("Session cleanup incomplete: {error}");
        }
    }
}

fn owned_forwards(list: &str, serial: &str, local: u16, remote: u16) -> Vec<String> {
    let remote = format!("tcp:{remote}");
    list.lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() != 3 || fields[0] != serial || fields[2] != remote {
                return None;
            }
            let port = fields[1].strip_prefix("tcp:")?.parse::<u16>().ok()?;
            if port == 0 || port != local {
                return None;
            }
            Some(format!("tcp:{port}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_cleanup_checks_device_local_and_remote_identity() {
        let list = "one tcp:1001 tcp:2001\none tcp:1002 tcp:2002\ntwo tcp:1003 tcp:2001\none tcp:0 tcp:2001\none localabstract:foreign tcp:2001\nbad line";
        assert_eq!(owned_forwards(list, "one", 1001, 2001), ["tcp:1001"]);
        assert!(owned_forwards(list, "one", 1001, 2002).is_empty());
        assert!(owned_forwards(list, "two", 1001, 2001).is_empty());
        assert!(owned_forwards(list, "one", 0, 2001).is_empty());
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::OnceLock;

        fn quote(path: &Path) -> String {
            format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
        }

        fn daemon() -> &'static Path {
            static BINARY: OnceLock<PathBuf> = OnceLock::new();
            BINARY.get_or_init(|| {
                let directory = std::env::temp_dir().join(format!(
                    "socketsweep-session-build-{}",
                    new_random_id().unwrap()
                ));
                fs::create_dir(&directory).unwrap();
                let binary = directory.join("daemon");
                let source = Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .join("engine/daemon.cpp");
                assert!(
                    Command::new(std::env::var("CXX").unwrap_or_else(|_| "c++".into()))
                        .args([
                            "-std=c++17",
                            "-O2",
                            "-pthread",
                            "-fno-exceptions",
                            "-fno-rtti",
                            "-Wall",
                            "-Wextra",
                            "-Wpedantic"
                        ])
                        .arg(source)
                        .arg("-o")
                        .arg(&binary)
                        .status()
                        .unwrap()
                        .success()
                );
                binary
            })
        }

        struct Device {
            root: PathBuf,
        }
        impl Device {
            fn new() -> Self {
                let root = std::env::temp_dir().join(format!(
                    "socketsweep session tests {}",
                    new_random_id().unwrap()
                ));
                fs::create_dir(&root).unwrap();
                fs::create_dir(root.join("phone")).unwrap();
                // A foreign mapping must survive every cleanup and failure.
                fs::write(
                    root.join("forwards.json"),
                    r#"[["foreign","tcp:1234","tcp:5678"]]"#,
                )
                .unwrap();
                Self { root }
            }
            fn client(&self, name: &str, serial: &str) -> PathBuf {
                let base = self.root.join(name);
                fs::create_dir(&base).unwrap();
                let config = serde_json::json!({"base": base, "serial": serial, "phone":self.root.join("phone"), "registry":self.root.join("forwards.json")});
                let file = base.join("config.json");
                fs::write(&file, serde_json::to_vec(&config).unwrap()).unwrap();
                let helper = Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .join("tests/fake_session_adb.py");
                let executable = base.join("fake-adb");
                fs::write(
                    &executable,
                    format!(
                        "#!/bin/sh\nexec python3 {} {} \"$@\"\n",
                        quote(&helper),
                        quote(&file)
                    ),
                )
                .unwrap();
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
                executable
            }
            fn rows(&self) -> Vec<Vec<String>> {
                serde_json::from_slice(&fs::read(self.root.join("forwards.json")).unwrap()).unwrap()
            }
            fn directories(&self) -> usize {
                fs::read_dir(self.root.join("phone")).unwrap().count()
            }
        }
        impl Drop for Device {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
        fn fail(adb: &Path, stage: &str) {
            fs::write(adb.parent().unwrap().join("fail"), stage).unwrap();
        }
        fn ping(session: &Session) -> String {
            let c = session.connection();
            crate::daemon_command_at(c.address, "PING", &c.token, Duration::from_secs(2)).unwrap()
        }

        #[test]
        fn two_sessions_on_same_or_different_devices_remain_independent() {
            for serials in [("same", "same"), ("first", "second")] {
                let device = Device::new();
                let adb_a = device.client("client-a", serials.0);
                let adb_b = device.client("client-b", serials.1);
                let (mut a, response_a) =
                    Session::start(adb_a.clone(), daemon(), serials.0.into(), false).unwrap();
                let (mut b, _) = Session::start(adb_b, daemon(), serials.1.into(), false).unwrap();
                assert_ne!(a.directory, b.directory);
                assert_ne!(a.connection.address, b.connection.address);
                assert_ne!(a.connection.token, b.connection.token);
                assert!(!response_a.contains(&a.connection.token));
                assert_eq!(device.rows().len(), 3);
                let local = device
                    .root
                    .join("phone")
                    .join(a.directory.rsplit('/').next().unwrap());
                assert_eq!(
                    fs::metadata(&local).unwrap().permissions().mode() & 0o777,
                    0o700
                );
                assert_eq!(
                    fs::metadata(local.join("daemon"))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o700
                );
                assert!(!local.join("token").exists());
                assert!(a.cleanup().is_empty());
                assert_eq!(device.rows().len(), 2);
                assert_eq!(device.directories(), 1);
                assert!(ping(&b).contains("\"status\":\"ok\""));
                let c = b.connection();
                let ack = crate::daemon_command_at(
                    c.address,
                    "SHUTDOWN",
                    &c.token,
                    Duration::from_secs(2),
                )
                .unwrap();
                crate::confirm_shutdown(&ack).unwrap();
                assert!(b.cleanup().is_empty());
                assert_eq!(device.rows().len(), 1);
                assert_eq!(device.directories(), 0);
                let calls =
                    fs::read_to_string(adb_a.parent().unwrap().join("calls.jsonl")).unwrap();
                assert!(!calls.contains(&a.connection.token));
                for forbidden in ["pkill", "kill-server", "--remove-all", "nohup"] {
                    assert!(!calls.contains(forbidden));
                }
            }
        }

        #[test]
        fn startup_failures_retire_only_the_failed_sessions_resources() {
            let device = Device::new();
            let (mut survivor, _) = Session::start(
                device.client("survivor", "same"),
                daemon(),
                "same".into(),
                false,
            )
            .unwrap();
            for stage in [
                "features",
                "mkdir",
                "token",
                "push",
                "chmod",
                "launch",
                "ready",
                "bad-ready",
                "handshake",
            ] {
                let adb = device.client(stage, "same");
                fail(&adb, stage);
                assert!(
                    Session::start(adb, daemon(), "same".into(), false).is_err(),
                    "accepted {stage}"
                );
                assert_eq!(
                    device.rows().len(),
                    2,
                    "leaked/collateral forward at {stage}"
                );
                assert_eq!(
                    device.directories(),
                    1,
                    "leaked/collateral directory at {stage}"
                );
                assert!(ping(&survivor).contains("\"status\":\"ok\""));
            }
            assert!(survivor.cleanup().is_empty());
        }

        #[test]
        fn unconfirmed_forward_allocations_are_reported_without_guessing_ownership() {
            for stage in ["forward", "bad-forward"] {
                let device = Device::new();
                let (mut survivor, _) = Session::start(
                    device.client("survivor", "same"),
                    daemon(),
                    "same".into(),
                    false,
                )
                .unwrap();
                let adb = device.client(stage, "same");
                fail(&adb, stage);
                let error = Session::start(adb, daemon(), "same".into(), false)
                    .err()
                    .unwrap();
                assert!(error.contains("unused local forward may remain"), "{error}");
                assert_eq!(device.rows().len(), 3); // foreign, survivor, unknown allocation
                assert_eq!(device.directories(), 1); // failed daemon/files are still retired
                assert!(ping(&survivor).contains("\"status\":\"ok\""));
                assert!(survivor.cleanup().is_empty());
                assert_eq!(device.rows().len(), 2);
            }
        }

        #[test]
        fn su_commands_preserve_privilege_but_cannot_fake_a_root_handshake() {
            let device = Device::new();
            let adb = device.client("su", "same");
            let result = Session::start(adb.clone(), daemon(), "same".into(), true);
            let root = Command::new("id").arg("-u").output().unwrap().stdout == b"0\n";
            assert_eq!(result.is_ok(), root);
            drop(result);
            assert_eq!(device.directories(), 0);
            assert_eq!(device.rows().len(), 1);
            let calls = fs::read_to_string(adb.parent().unwrap().join("calls.jsonl")).unwrap();
            assert!(calls.contains("--read-only"));
            assert!(calls.contains("su -c"));
            assert!(calls.contains("rmdir"));
            fail(&adb, "root");
            assert!(Session::start(adb, daemon(), "same".into(), true).is_err());
            assert_eq!(device.directories(), 0);
        }

        #[test]
        fn cleanup_deadline_still_closes_its_lifetime_channel() {
            let device = Device::new();
            let adb = device.client("slow", "same");
            let (mut session, _) =
                Session::start(adb.clone(), daemon(), "same".into(), false).unwrap();
            let address = session.connection.address;
            fail(&adb, "cleanup-timeout");
            let started = Instant::now();
            assert!(!session.cleanup().is_empty());
            assert!(started.elapsed() < Duration::from_secs(8));
            assert!(
                std::net::TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_err()
            );
        }

        #[test]
        fn cleanup_preserves_a_forward_that_was_rebound_to_a_foreign_endpoint() {
            let device = Device::new();
            let (mut session, _) = Session::start(
                device.client("rebound", "same"),
                daemon(),
                "same".into(),
                false,
            )
            .unwrap();
            let mut rows = device.rows();
            let local = format!("tcp:{}", session.connection.address.port());
            rows.iter_mut().find(|row| row[1] == local).unwrap()[2] = "tcp:9999".into();
            fs::write(
                device.root.join("forwards.json"),
                serde_json::to_vec(&rows).unwrap(),
            )
            .unwrap();
            assert!(session.cleanup().is_empty());
            assert_eq!(device.rows(), rows);
            assert_eq!(device.directories(), 0);
        }

        #[test]
        fn adb_output_is_bounded_and_inherited_pipes_cannot_extend_its_deadline() {
            let device = Device::new();
            let adb = device.client("pipes", "same");
            let call = |operation| {
                adb_with_input_timeout(
                    &adb,
                    &["-s", "same", operation],
                    None,
                    Duration::from_millis(200),
                )
            };
            let error =
                adb_with_input_timeout(&adb, &["-s", "same", "huge"], None, Duration::from_secs(2))
                    .unwrap_err();
            assert!(error.contains("limit"), "{error}");
            let started = Instant::now();
            assert!(call("held-pipe").unwrap_err().contains("timed out"));
            assert!(started.elapsed() < Duration::from_secs(2));
        }
    }
}
