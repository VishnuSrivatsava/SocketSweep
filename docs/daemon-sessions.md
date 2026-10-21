# Owned daemon sessions

Tracked in [#37](https://github.com/VishnuSrivatsava/SocketSweep/issues/37).
Rebuild the Android daemon before using this startup path. The scan wire
protocol remains version 3 with scan stream v1; the new startup flag is required
and there is no fallback to the old shared process/port.

## Ownership and lifetime

One Rust `Session` owns the selected device serial, privilege mode, secret,
loopback endpoint, read-only state, device files, and an unreaped ADB child.
Only a verified authenticated handshake publishes that session to commands.
Connection changes/scans/deletion retain their operation lock; cancellation and
progress acknowledgements retain their separate scan-ID scope.

Each connection creates `/data/local/tmp/socketsweep-<random-256-bit-id>/`
exclusively with mode 0700. It pushes a private `daemon` executable (0700) and
writes a distinct secret through stdin into `token` (0600). The daemon consumes
and unlinks the token before accepting connections. Neither the session secret
nor a public scan generation is used as a device-path identifier.

The daemon binds loopback port **0**, letting the device kernel allocate a free
port. It atomically publishes a complete 0600 `ready` record containing its port
and PID, without replacing an existing file or symlink. Publication uses atomic
no-overwrite rename (`renameat2` with `RENAME_NOREPLACE` on Android/Linux,
`renamex_np` with `RENAME_EXCL` in macOS host tests). It does not require hard
links: [Android shell policy](https://android.googlesource.com/platform/system/sepolicy/+/refs/heads/main/private/shell.te)
grants creation and rename of shell data files, while the
[creation permission set](https://android.googlesource.com/platform/system/sepolicy/+/refs/heads/main/public/global_macros)
does not include hard linking. The host then asks ADB
for `forward --no-rebind tcp:0 tcp:<device-port>` and records the returned host
port. All subsequent device commands use the selected `-s <serial>` explicitly.
Setup offers [explicit device selection](device-selection.md). Startup checks
that the chosen serial is still ready before creating new session resources;
it never falls back to another serial.

The foreground daemon is launched through **`adb shell -T`**, with an owned stdin
pipe held open by the Rust session. `--session-ready` also enables its lifetime
watcher. EOF/error on that input exits only that process, including when a TCP
command is blocked. This requires ADB shell v2; unsupported devices fail before
creating session files. There is no `nohup`, process-name kill, or remote PID
signal. A PID in a readiness file never grants termination authority.

[ADB documents raw non-PTY shells and allocated forwarding ports](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md).
Its [shell service](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/daemon/shell_service.cpp)
handles the shell-v2 close-stdin packet by shutting down input for a raw shell;
PTY shells cannot provide that half-close behavior. This is why `-T` and the
feature check are part of the contract.

The targeted `adb features` CLI prints **one feature per line** (LF or CRLF),
unlike the comma-separated feature set on the ADB wire. The host requires an
exact `shell_v2` feature line. The fake-ADB fixture uses a multi-feature response
to exercise this distinction; devices without that capability still fail before
creating session files.

## Teardown and failures

Stop first requests authenticated `SHUTDOWN` from the owned endpoint. Only the
actual `shutting down` acknowledgement produces a confirmed shutdown result.
Local scan authority is invalidated even when the reply is missing/rejected.
Cleanup always releases the lifetime pipe and its owned host child. EOF is a
safety/lifetime mechanism, not an invented remote acknowledgement.

Forward removal requires the recorded **serial + local port + remote port** to
match the current ADB table. A changed mapping is left intact. Cleanup removes
only the private session's known `token`, `ready`, `ready.tmp`, and `daemon`
files, then uses `rmdir`; unexpected extra files prevent directory removal.
There is no recursive session sweep, legacy-file deletion, `--remove-all`, or
ADB-server/adbd restart. Normal app exit cancels an active scan and drops the
owned session; host process death closes the pipe at the OS boundary.

Session startup has a shared 45-second budget after device discovery. Individual
ADB commands use at most 15 seconds. Cleanup shares a 5-second ADB budget plus
up to 250 ms of local-child grace; only the owned, unreaped host child is killed
and waited for if needed. Shutdown requests have an absolute 3-second network
deadline. Small command reads/writes use an absolute deadline and the existing
128 KiB response limit. ADB stdout/stderr each have a 256 KiB limit and share
their command deadline, including inherited pipes after child exit. Token stdin
is bounded to 128 bytes (the actual token line is 65 bytes).

Early daemon exit reports its exit status and a bounded 2 KiB prefix of startup
stderr in the diagnostic log. Remaining stderr is drained without retaining it,
so verbose output cannot block the lifetime child. Waiting for the prefix after
exit uses at most 250 ms within the startup deadline. The connection toast uses
only the first summary line; raw diagnostics do not fill it. Readiness creation,
write, close and publication failures identify their stage on stderr.

| Failure | Ownership-safe result |
| --- | --- |
| Feature/root check or exclusive directory creation fails | No published session; no guessed directory cleanup. |
| Token, push, chmod, launch, readiness, or handshake fails | The guard releases its child and removes confirmed owned resources within the cleanup budget. |
| Forward creation reply is lost or malformed | The daemon/files are retired; the unknown local listener is not guessed. Startup reports that an unused forward may remain. |
| Mapping was rebound | Cleanup preserves the changed mapping. Other SocketSweep sessions allocate new ports and do not rebind existing ones. |
| Device disappears, root permission changes, or cleanup times out | Local state/child are released; private files or a forward may remain. Cleanup errors do not authorize broader deletion. |
| App crashes during startup | The lifetime channel retires a launched daemon; private files may remain, including a 0600 token if launch had not consumed it yet. |

ADB is a shared service controlled by the desktop account. This design isolates
cooperating SocketSweep sessions; it does not claim protection from that same
account deliberately force-rebinding mappings or replacing the bundled tools.
Android shell storage permission grants remain shared by the shell UID, as in
the existing setup. Root launches still use only an already-root adbd or
approved `su`, and the authenticated root daemon must report read-only mode.

## Validation and manual device check

The Rust fixtures use a fake ADB executable, private local files, and the real
host-built C++ daemon. They test same-serial and different-serial sessions,
independent secrets/ports/lifetimes, permissions, staged startup failures,
missing allocation replies, replaced mappings, root-handshake rejection, cleanup
deadlines, output bounds, and inherited-pipe timeouts. The fake forward uses the
host daemon's port directly: it validates ownership/command construction, not
the real USB tunnel or root-manager stdin behavior. Unix integration fixtures
run on Linux/macOS; Windows retains the common ownership guard and existing
Rust tests plus the full desktop build.

Four Python tests exercise actual daemon lifetime EOF, including an incomplete
authenticated command, two simultaneous listeners, root/read-only metadata,
atomic readiness permissions, and preservation of existing files/symlinks. CI
also runs these under root in a disposable Linux job. Existing protocol,
deletion, streaming, frontend, symbol, and packaging checks remain enabled.

No native app, real ADB, or phone test is run locally for this change. To check
the real device manually, run the following yourself from the repository:

```sh
bash engine/build.sh
npm run tauri build
```

Launch two copies of the built app (on macOS, use
`open -n /path/to/SocketSweep.app` for each). Connect/scan in both, stop one, and
rescan in the other. Repeat reconnects and check that an unrelated ADB forward
survives. Unplugging should clear local state without a false shutdown
acknowledgement. On an already-root-capable device, also validate approved-su
startup and read-only controls. Do not restart adbd or the shared ADB server as
part of an isolation test. Record actual device results separately from the
host fixtures.

The host readiness regression also links a test executable whose `link()` always
fails with `EPERM`. The former publication failed before readiness in that
fixture; atomic rename succeeds, while existing-file/symlink rejection and
owner-EOF tests remain enforced. This models the missing permission, not a full
Android SELinux environment. Physical-device confirmation remains required.
