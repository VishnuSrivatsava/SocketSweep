"""Real host daemon lifetime tests; no Android device or ADB executable."""
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import subprocess
import tempfile
import time

from test_daemon import DaemonHarness


class OwnedSessionTests(DaemonHarness):
    def setUp(self):
        self.files = tempfile.TemporaryDirectory(prefix="socketsweep owned sessions ")
        self.addCleanup(self.files.cleanup)
        self.children = []
        self.addCleanup(self.close_children)

    def close_children(self):
        for child in self.children:
            if child.stdin:
                child.stdin.close()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            child.stderr.close()

    def launch(self, name, read_only=False, prepare=None, closed_input=False):
        directory = Path(self.files.name) / name
        directory.mkdir(mode=0o700)
        token = secrets.token_hex(32)
        token_file = directory / "token"
        token_file.write_text(token + "\n")
        token_file.chmod(0o600)
        ready = directory / "ready"
        if prepare:
            prepare(ready)
        args = [self.binary, "0", str(token_file), "--session-ready", str(ready)]
        if read_only:
            args.append("--read-only")
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL if closed_input else subprocess.PIPE,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.children.append(child)
        return child, ready, token

    def wait_ready(self, child, path):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if path.exists():
                ready = json.loads(path.read_text())
                self.assertGreater(ready["port"], 0)
                self.assertEqual(ready["pid"], child.pid)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertFalse(path.with_name("token").exists())
                self.assertFalse(Path(str(path) + ".tmp").exists())
                return ready["port"]
            if child.poll() is not None:
                self.fail(child.stderr.read().decode())
            time.sleep(0.01)
        self.fail("No complete readiness record")

    def command(self, port, token, command="PING"):
        with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
            client.sendall(f"AUTH {token}\n{command}\n".encode())
            client.shutdown(socket.SHUT_WR)
            with client.makefile("rb") as response:
                return json.loads(response.readline())

    def test_two_live_sessions_have_distinct_ports_secrets_and_lifetimes(self):
        a, path_a, token_a = self.launch("one")
        b, path_b, token_b = self.launch("two", read_only=True)
        port_a, port_b = self.wait_ready(a, path_a), self.wait_ready(b, path_b)
        self.assertNotEqual(port_a, port_b)
        self.assertEqual(self.command(port_a, token_a)["read_only"], os.geteuid() == 0)
        self.assertTrue(self.command(port_b, token_b)["read_only"])
        self.assertEqual(self.command(port_a, token_b)["status"], "error")
        a.stdin.close()
        a.stdin = None
        self.assertEqual(a.wait(timeout=1), 0)
        self.assertEqual(self.command(port_b, token_b)["status"], "ok")
        self.assertEqual(self.command(port_b, token_b, "SHUTDOWN")["message"], "shutting down")
        self.assertEqual(b.wait(timeout=1), 0)

    def test_owner_eof_interrupts_an_incomplete_command_without_touching_other_session(self):
        a, ready_a, token_a = self.launch("blocked")
        b, ready_b, token_b = self.launch("survivor")
        port_a, port_b = self.wait_ready(a, ready_a), self.wait_ready(b, ready_b)
        with socket.create_connection(("127.0.0.1", port_a), timeout=2) as peer:
            peer.sendall(f"AUTH {token_a}".encode())  # no newline: command timeout would be 30 seconds
            started = time.monotonic()
            a.stdin.close()
            a.stdin = None
            self.assertEqual(a.wait(timeout=1), 0)
            self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(self.command(port_b, token_b)["status"], "ok")

    def test_readiness_publication_does_not_replace_existing_files_or_symlinks(self):
        for kind in ("ready", "ready-link", "temporary", "temporary-link"):
            with self.subTest(kind=kind):
                def prepare(ready):
                    target = ready.parent / "keep"
                    target.write_text("keep")
                    path = Path(str(ready) + ".tmp") if kind.startswith("temporary") else ready
                    if kind.endswith("link"):
                        path.symlink_to(target)
                    else:
                        path.write_text("keep")
                child, ready, _ = self.launch(kind, prepare=prepare)
                self.assertNotEqual(child.wait(timeout=2), 0)
                self.assertEqual((ready.parent / "keep").read_text(), "keep")
                path = Path(str(ready) + ".tmp") if kind.startswith("temporary") else ready
                self.assertEqual(path.read_text(), "keep")

    def test_missing_owner_input_exits_without_a_detached_process(self):
        child, _, _ = self.launch("already-closed", closed_input=True)
        self.assertEqual(child.wait(timeout=1), 0)
