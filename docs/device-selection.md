# Selecting an Android device

Tracked in [#4](https://github.com/VishnuSrivatsava/SocketSweep/issues/4).

Setup lists the serial, available model, and state of devices reported by
`adb devices -l`. Exactly one ready device is selected initially. With multiple
ready devices, choose one explicitly before connecting. Offline, unauthorized,
USB-permission-denied, and other unavailable states cannot be connected.

Refresh updates the list. The chosen serial remains selected even when it
disappears, becomes unavailable, or the list order changes. A disconnected
selection stays visible and blocks Connect; choosing another phone is an
explicit action. Selection survives refreshes, connection errors, and stopping
within the running app. It is not saved across app restarts.

Discovery runs on entering setup and on Refresh, without background polling.
Its result is a snapshot. Connect checks the selected serial against a fresh
list in Rust before pushing or launching the daemon. If it vanished after the
displayed snapshot, startup fails; there is no first-device fallback. If it
vanishes after that check, subsequent `-s` commands still target only that serial
and fail normally. A model label is display text, never a connection identifier.
Results show the serial that was selected for their session.

## Ownership and bounds

[ADB's documented CLI](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md)
provides long device listing and explicit `-s SERIAL` targeting. No native ADB
library is added. Listing uses the existing 15-second command deadline and
256 KiB limits for each captured output stream. Invalid lists and duplicate
serials fail rather than guessing a transport. Resolve duplicate serials by
disconnecting duplicate transports; transport-ID selection is not implemented.

Version checks and device discovery are host-wide read-only commands. Session
startup, privilege checks, file operations, and forwarding cleanup retain the
selected serial through [owned daemon sessions](daemon-sessions.md). Reconnect
releases the app's previous session and invalidates scan authority before
validating the requested device. A new scan gets a new generation; old IDs and
destructive confirmations cannot be reused for a different session. Root mode
still requires verified read-only root access and never restarts adbd.

Refresh and selection are disabled during connection. Connect is disabled while
discovery is pending/failed or the selected device is unavailable. A synchronous
action guard prevents repeated clicks from starting duplicate connections.
Discovery responses from a superseded request or a completed setup phase cannot
replace current state. Native select/label controls retain keyboard access;
unavailable states have visible explanations and status text.

## Validation

Rust parsing tests cover USB, wireless, emulator, model metadata, CRLF, empty and
invalid output, unavailable states, and duplicate serials. A fake ADB fixture
checks discovery afresh, starts the second selected serial with the real
host-built daemon, and rejects unavailable/missing/invalid selections while
another ready device remains listed. The fixture rejects any device command
that does not target its configured serial. Existing same/different-serial
session isolation, generation invalidation, authentication, deletion, and root
tests remain enabled.

Node tests cover initial selection, preservation, and status guidance. The
built-UI mocked-IPC replay covers multiple ready devices, disabled unavailable
options, model-text escaping, refresh locks/failure, unplugging, reordering,
reconnection, a stale displayed device at startup, duplicate clicks, result
identity, explicit switching, and confirmation invalidation. These fixtures do
not prove real USB transport, physical hotplug timing, or root-manager behavior.

No native app, real ADB, or phone test was run locally. For a manual check, build
the app yourself using the README steps, then:

1. Connect two authorized phones/emulators. Confirm that neither is chosen
   initially and select the second one. Scan and verify the displayed serial.
2. Stop, unplug that device, and refresh. It must remain selected as disconnected;
   the other phone must not be used automatically.
3. Reconnect/authorize it, refresh, and scan again. Also try unplugging between
   Refresh and Connect; startup must fail instead of switching phones.
4. Stop, explicitly select the other phone, and scan. Old results and deletion
   confirmations must be gone. Root mode, if available, remains read-only.
5. Repeat with two app instances; stopping one must leave the other's session
   functional. Keep real device results separate from host/mock validation.
