"""Bounded command ingestion, controlled short reads, and real TCP framing."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import unittest

from test_daemon import DaemonHarness


class CommandReaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="socketsweep-command-build-")
        cls.binary = str(Path(cls.build.name) / "command-tests")
        compiler = os.environ.get("CXX") or shutil.which("clang++") or "c++"
        subprocess.run([compiler, "-std=c++17", "-O2", "-pthread", "-Wall", "-Wextra",
                        "-Wpedantic", "-fno-exceptions", "-fno-rtti",
                        str(Path(__file__).with_name("command_input_test.cpp")),
                        "-o", cls.binary], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def run_case(self, case):
        result = subprocess.run([self.binary, case], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_coalesced_lines_reduce_syscalls_and_preserve_surplus(self): self.run_case("coalesced")
    def test_forced_short_reads_preserve_utf8_and_spaces(self): self.run_case("splits")
    def test_chunk_and_exact_line_boundaries(self): self.run_case("bounds")
    def test_invalid_delimiters_and_truncated_input(self): self.run_case("invalid")
    def test_interrupted_and_would_block_reads_retry_without_loss(self): self.run_case("interruptions")
    def test_poll_interruptions_consume_the_same_deadline_budget(self): self.run_case("deadline")
    def test_authentication_and_single_command_dispatch(self): self.run_case("dispatch")
    def test_coalesced_extra_stream_bytes_cannot_enable_deletion(self): self.run_case("stream_extra")


class CommandFramingTests(DaemonHarness):
    def fragmented_request(self, pieces):
        with socket.create_connection(("127.0.0.1", self.port), timeout=2) as client:
            for piece in pieces:
                client.sendall(piece)
            client.shutdown(socket.SHUT_WR)
            with client.makefile("rb") as response:
                return json.loads(response.readline())

    def test_auth_and_ping_accept_every_two_piece_split(self):
        payload = f"AUTH {self.token}\nPING\n".encode()
        for split in range(1, len(payload)):
            self.assertEqual(self.fragmented_request([payload[:split], payload[split:]])["status"], "ok")

    @unittest.skipIf(os.geteuid() == 0, "Writable daemon test requires an unprivileged user")
    def test_fragmented_delete_keeps_unicode_and_trailing_spaces_exact(self):
        sibling = self.root / " 写真"
        sibling.write_text("keep")
        target = self.root / " 写真 "
        payload = f"AUTH {self.token}\nDELETE {target}\n".encode()
        start = payload.index("写真".encode())
        for split in range(start, len(payload)):
            target.write_text("delete")
            self.scan()
            result = self.fragmented_request([payload[:split], payload[split:]])
            self.assertEqual(result["status"], "ok")
            self.assertFalse(target.exists())
            self.assertEqual(sibling.read_text(), "keep")

    def test_legacy_request_dispatches_only_its_first_command(self):
        target = self.root / "keep"
        target.write_text("keep")
        self.scan()
        payload = f"AUTH {self.token}\nPING\nDELETE {target}\nSHUTDOWN\n".encode()
        self.assertEqual(self.raw_request(payload)["message"], "pong")
        self.assertTrue(target.exists())
        self.assertEqual(self.request("PING")["status"], "ok")

    def test_line_limit_counts_bytes_and_accepts_exactly_16_kib(self):
        for command in ["x" * (16 * 1024), "é" * (8 * 1024)]:
            self.assertEqual(self.request(command)["message"], "Unknown command")
            self.assertEqual(self.request(command + "x")["message"], "Invalid command framing")

    def test_missing_newline_never_dispatches_shutdown(self):
        for payload in [f"AUTH {self.token}".encode(), f"AUTH {self.token}\nSHUTDOWN".encode()]:
            self.assertEqual(self.raw_request(payload)["status"], "error")
        self.assertEqual(self.request("PING")["status"], "ok")
