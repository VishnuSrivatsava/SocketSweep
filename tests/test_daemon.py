"""Exercise the daemon against disposable files, without an Android device.

Run: python3 -m unittest discover -s tests -v
"""

import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import unittest


class DaemonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build_dir = tempfile.TemporaryDirectory(prefix="socketsweep-test-build-")
        cls.binary = str(Path(cls.build_dir.name) / "daemon")
        compiler = os.environ.get("CXX") or shutil.which("clang++") or "c++"
        source = Path(__file__).resolve().parents[1] / "engine" / "daemon.cpp"
        subprocess.run([compiler, "-std=c++17", "-O2", "-Wall", "-Wextra",
                        "-Wpedantic", "-fno-exceptions", "-fno-rtti",
                        str(source), "-o", cls.binary], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.build_dir.cleanup()

    def setUp(self):
        self.files = tempfile.TemporaryDirectory(prefix="socketsweep-test-files-")
        self.addCleanup(self.files.cleanup)
        self.root = Path(self.files.name) / "storage"
        self.root.mkdir()
        self.token = secrets.token_hex(32)
        token_file = Path(self.files.name) / "session"
        token_file.write_text(self.token + "\n")
        token_file.chmod(0o600)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        self.process = subprocess.Popen([self.binary, str(self.port), str(token_file)],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.addCleanup(self.stop)
        for _ in range(100):
            try:
                self.request("PING")
                break
            except OSError:
                if self.process.poll() is not None:
                    self.fail(self.process.stderr.read().decode())
                time.sleep(0.01)
        else:
            self.fail("Daemon did not start")
        self.assertFalse(token_file.exists(), "Startup secret must be consumed")

    def stop(self):
        if self.process.poll() is None:
            try:
                self.request("SHUTDOWN")
                self.process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait()
        self.process.stderr.close()

    def raw_request(self, payload):
        with socket.create_connection(("127.0.0.1", self.port), timeout=2) as client:
            client.sendall(payload)
            client.shutdown(socket.SHUT_WR)
            data = b""
            while not data.endswith(b"\n"):
                chunk = client.recv(65536)
                if not chunk:
                    break
                data += chunk
        return json.loads(data)

    def request(self, command):
        return self.raw_request(f"AUTH {self.token}\n{command}\n".encode())

    def scan(self):
        result = self.request(f"SCAN {self.root}")
        self.assertEqual(result["status"], "ok")
        return result

    def test_authenticated_ping_and_scan(self):
        (self.root / "photo").write_bytes(b"1234567")
        self.assertEqual(self.request("PING")["protocol_version"], 2)
        result = self.scan()
        self.assertEqual(result["total_files"], 1)
        self.assertEqual(result["total_size"], 7)

    def test_commands_require_the_current_secret(self):
        target = self.root / "keep"
        target.write_text("keep")
        self.scan()
        for command in ["PING", f"SCAN {self.root}", f"DELETE {target}", "SHUTDOWN"]:
            self.assertEqual(self.raw_request((command + "\n").encode())["status"], "error")
            wrong = f"AUTH {'0' * 64}\n{command}\n".encode()
            self.assertEqual(self.raw_request(wrong)["status"], "error")
        self.assertTrue(target.exists())
        self.assertEqual(self.request("PING")["status"], "ok")

    def test_delete_preserves_filename_spaces(self):
        sibling = self.root / "report"
        sibling.write_text("keep")
        for name in ["report ", " report", " report "]:
            target = self.root / name
            target.write_text("delete")
            self.scan()
            self.assertEqual(self.request(f"DELETE {target}")["status"], "ok")
            self.assertFalse(target.exists())
            self.assertTrue(sibling.exists())

    def test_invalid_frames_do_not_delete_a_shorter_path(self):
        target = self.root / "report"
        target.write_text("keep")
        self.scan()
        for suffix in [b"\r\n", b"\0other\n", b"", b"x" * (16 * 1024) + b"\n"]:
            payload = f"AUTH {self.token}\nDELETE {target}".encode() + suffix
            self.assertEqual(self.raw_request(payload)["status"], "error")
            self.assertTrue(target.exists())

    def test_delete_requires_scan_and_rejects_root_and_escapes(self):
        target = self.root / "keep"
        target.write_text("keep")
        self.assertEqual(self.request(f"DELETE {target}")["status"], "error")
        outside = Path(self.files.name) / "storage-other"
        outside.mkdir()
        other = outside / "keep"
        other.write_text("keep")
        (self.root / "escape").symlink_to(outside, target_is_directory=True)
        self.scan()
        for path in [self.root, outside, other, self.root / ".." / "storage-other" / "keep",
                     self.root / "escape" / "keep"]:
            self.assertEqual(self.request(f"DELETE {path}")["status"], "error")
        self.assertTrue(target.exists())
        self.assertTrue(other.exists())

    def test_failed_scan_clears_previous_delete_root(self):
        target = self.root / "keep"
        target.write_text("keep")
        self.scan()
        self.assertEqual(self.request(f"SCAN {self.root / 'missing'}")["status"], "error")
        self.assertEqual(self.request(f"DELETE {target}")["status"], "error")
        self.assertTrue(target.exists())

    def test_scan_verb_must_be_exact(self):
        self.assertEqual(self.request(f"SCANOTHER {self.root}")["status"], "error")


if __name__ == "__main__":
    unittest.main()
