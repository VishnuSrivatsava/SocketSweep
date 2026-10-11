"""Run the real UID-0 daemon in an isolated, disposable Linux chroot.

CI runs this file with sudo; ordinary test discovery skips it. The daemon is
statically linked and placed under /dev so full scans only count fixture data.
No Android device, real device storage, or filesystem mounts are involved.
"""

import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0,
                     "Requires Linux root for the disposable chroot")
class RootScanSandboxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="socketsweep-root-build-")
        cls.binary = Path(cls.build.name) / "daemon"
        source = Path(__file__).resolve().parents[1] / "engine" / "daemon.cpp"
        subprocess.run([os.environ.get("CXX", "g++"), "-std=c++17", "-O2", "-pthread", "-static",
                        "-Wall", "-Wextra", "-Wpedantic", "-fno-exceptions",
                        "-fno-rtti", str(source), "-o", str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        self.files = tempfile.TemporaryDirectory(prefix="socketsweep-root-fs-")
        self.addCleanup(self.files.cleanup)
        self.root = Path(self.files.name)
        for name in ["data", "system", "mnt", "storage", "data_mirror", "apex", "proc", "sys", "dev"]:
            (self.root / name).mkdir()
            if name not in ["data", "system"]:
                (self.root / name / "excluded").write_bytes(b"must not be counted")
        (self.root / "data" / "private").write_bytes(b"private app data")
        (self.root / "system" / "system-file").write_bytes(b"system files")
        shutil.copy2(self.binary, self.root / "dev" / "daemon")
        self.token = secrets.token_hex(32)
        token_file = self.root / "dev" / "token"
        token_file.write_text(self.token + "\n")
        token_file.chmod(0o600)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        # Deliberately omit --read-only: UID 0 must enforce it on its own.
        self.process = subprocess.Popen(["chroot", str(self.root), "/dev/daemon",
                                         str(self.port), "/dev/token"],
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
            self.fail("Sandbox daemon did not start")
        self.assertFalse(token_file.exists())

    def request(self, command):
        with socket.create_connection(("127.0.0.1", self.port), timeout=2) as client:
            client.sendall(f"AUTH {self.token}\n{command}\n".encode())
            client.shutdown(socket.SHUT_WR)
            data = b""
            while not data.endswith(b"\n"):
                chunk = client.recv(65536)
                if not chunk:
                    break
                data += chunk
        return json.loads(data)

    def stop(self):
        if self.process.poll() is None:
            try:
                self.request("SHUTDOWN")
                self.process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait()
        self.process.stderr.close()

    def test_whole_internal_scan_excludes_aliases_and_uses_single_slash_paths(self):
        status = self.request("PING")
        self.assertEqual(status["uid"], 0)
        self.assertTrue(status["read_only"])
        result = self.request("SCAN /")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["tree"]["path"], "/")
        self.assertEqual(result["total_files"], 2)
        self.assertEqual(result["total_size"], len(b"private app data") + len(b"system files"))
        self.assertEqual(result["skipped"], 7)
        self.assertEqual({node["path"] for node in result["tree"]["children"]}, {"/data", "/system"})

    def test_root_alias_cannot_bypass_exclusions_and_rescans_reset_deduplication(self):
        (self.root / "alias").symlink_to("/", target_is_directory=True)
        os.link(self.root / "data" / "private", self.root / "data" / "hard-link")
        for path in ["/alias/.", "/./", "/"]:
            result = self.request(f"SCAN {path}")
            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["tree"]["path"], "/")
            self.assertEqual(result["total_files"], 2)
            self.assertEqual(result["skipped"], 8)

    def test_uid_zero_cannot_delete_even_without_read_only_launch_flag(self):
        for scanned in [False, True]:
            if scanned:
                self.assertEqual(self.request("SCAN /data")["status"], "ok")
            result = self.request("DELETE /data/private")
            self.assertEqual(result["status"], "error")
            self.assertIn("read-only", result["message"])
            self.assertEqual((self.root / "data" / "private").read_bytes(), b"private app data")


if __name__ == "__main__":
    unittest.main()
