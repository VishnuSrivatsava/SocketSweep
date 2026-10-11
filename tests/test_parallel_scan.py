"""Scanner equivalence, scheduler resource bounds, and deterministic races."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from test_daemon import DaemonHarness


class ParallelScanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="socketsweep-parallel-build-")
        cls.binary = str(Path(cls.build.name) / "scanner-tests")
        compiler = os.environ.get("CXX") or shutil.which("clang++") or "c++"
        source = Path(__file__).with_name("parallel_scan_test.cpp")
        subprocess.run([compiler, "-std=c++17", "-O2", "-pthread", "-Wall", "-Wextra",
                        "-Wpedantic", "-fno-exceptions", "-fno-rtti", str(source),
                        "-o", cls.binary], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def run_case(self, case):
        result = subprocess.run([self.binary, case], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_all_worker_counts_match_serial_tree_and_totals(self): self.run_case("equivalence")
    def test_depth_limit_is_preserved(self): self.run_case("depth")
    def test_queued_directory_symlink_replacement_is_not_followed(self): self.run_case("symlink")
    def test_queued_directory_inode_replacement_is_reported(self): self.run_case("inode")
    def test_opened_directory_cannot_redirect_to_symlink_target(self): self.run_case("opened")
    def test_low_descriptor_limit_cleanup_and_worker_creation_failure(self): self.run_case("resources")
    def test_stream_all_worker_counts_match_serial_statistics(self): self.run_case("stream_equivalence")
    def test_stream_low_descriptor_limit_and_worker_creation_failure(self): self.run_case("stream_resources")
    def test_stream_queued_symlink_replacement_is_not_followed(self): self.run_case("stream_symlink")
    def test_stream_queued_inode_replacement_is_reported(self): self.run_case("stream_inode")
    def test_stream_opened_directory_cannot_redirect(self): self.run_case("stream_opened")
    def test_results_precede_completion_and_cancel_never_enables_deletion(self): self.run_case("stream_cancel")
    def test_stream_staging_budget_fails_without_success(self): self.run_case("stream_budget")
    def test_stream_root_replacement_fails_without_success(self): self.run_case("stream_root")


class ParallelProtocolTests(DaemonHarness):
    def test_worker_argument_validation(self):
        for flags in [["--threads"], ["--threads", "0"], ["--threads", "9"],
                      ["--threads", "4junk"], ["--threads", "-1"], ["--threads", "2", "--threads", "3"],
                      ["--read-only", "--read-only"], ["--unknown"]]:
            result = subprocess.run([self.binary, "5050", "unused-token", *flags],
                                    capture_output=True, text=True, timeout=3)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Usage:", result.stderr)

    def test_parallel_scan_keeps_protocol_and_directory_totals(self):
        for i in range(80):
            directory = self.root / str(i)
            directory.mkdir()
            (directory / "file").write_bytes(b"1234567")
        result = self.scan()
        self.assertEqual(result["scan_threads"], 1 if os.geteuid() == 0 else 4)
        self.assertEqual(result["total_files"], 80)
        self.assertEqual(result["total_dirs"], 81)
        self.assertEqual(result["total_size"], 560)
        self.assertEqual(result["errors"], 0)
        self.assertEqual(result["tree"]["size"], 560)
        self.assertTrue(all(child["size"] == 7 for child in result["tree"]["children"]))
