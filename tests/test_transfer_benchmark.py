"""Offline transfer-fixture tests. ADB calls are mocked; no device is used."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import benchmark_transfer as benchmark


class TransferBenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "fixture"
        self.manifest = benchmark.prepare(self.workspace, large_mib=1, small_count=3)
        self.source = self.workspace / self.manifest["fixture"]
        self.output = self.root / "run"

    def test_generated_workloads_match_and_do_not_overwrite(self):
        self.assertEqual(benchmark.load_manifest(self.workspace), self.manifest)
        self.assertEqual(benchmark.verify_copy(self.manifest, "large", self.source / "large"),
                         (1, benchmark.MIB))
        self.assertEqual(benchmark.verify_copy(self.manifest, "small", self.source / "small"),
                         (3, 3 * 4096))
        with self.assertRaises(FileExistsError):
            benchmark.prepare(self.workspace, 1, 3)
        self.assertEqual(benchmark.load_manifest(self.workspace), self.manifest)

    def test_bounds_rejected_before_creating_workspace(self):
        for large, small in [(0, 1), (1025, 1), (1, 0), (1, 5001)]:
            with self.assertRaises(ValueError):
                benchmark.prepare(self.root / "absent", large, small)
        self.assertFalse((self.root / "absent").exists())

    def test_corruption_missing_extra_directory_and_symlink_are_rejected(self):
        target = self.root / "copy"
        for change in ("hash", "size", "missing", "extra", "directory", "symlink"):
            with self.subTest(change=change):
                shutil.copytree(self.source / "small", target)
                path = target / "file-000000.bin"
                if change == "hash":
                    with path.open("r+b") as stream:
                        first = stream.read(1)
                        stream.seek(0)
                        stream.write(bytes([first[0] ^ 1]))
                elif change == "size":
                    path.write_bytes(b"short")
                elif change == "missing":
                    path.unlink()
                elif change == "extra":
                    (target / "unexpected").touch()
                elif change == "directory":
                    path.unlink()
                    path.mkdir()
                else:
                    path.unlink()
                    try:
                        path.symlink_to(self.source / "small" / path.name)
                    except OSError:
                        shutil.rmtree(target)
                        continue  # Some Windows environments deny symlink creation.
                with self.assertRaises(ValueError):
                    benchmark.verify_copy(self.manifest, "small", target)
                shutil.rmtree(target)

    def test_manifest_rejects_traversal_bad_hash_size_and_layout(self):
        for change in ("traversal", "absolute", "fixture", "hash", "size", "empty", "layout"):
            manifest = copy.deepcopy(self.manifest)
            files = manifest["files"]
            if change in ("traversal", "absolute"):
                files["../escape" if change == "traversal" else "/escape"] = files.pop("large/file-000000.bin")
            elif change == "fixture":
                manifest["fixture"] = "../escape"
            elif change == "hash":
                files["large/file-000000.bin"]["sha256"] = "not-a-hash"
            elif change == "size":
                files["large/file-000000.bin"]["bytes"] = True
            elif change == "empty":
                manifest["files"] = {}
            else:
                del files["small/file-000001.bin"]
            (self.workspace / "manifest.json").write_text(json.dumps(manifest))
            with self.subTest(change=change), self.assertRaises(ValueError):
                benchmark.load_manifest(self.workspace)

    def fake_copy(self, command, **kwargs):
        workload = command[-2].rsplit("/", 1)[1]
        shutil.copytree(self.source / workload, Path(command[-1]) / workload)
        self.assertTrue(kwargs["check"])
        self.assertEqual(kwargs["timeout"], 600)
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)

    def test_pull_pins_device_and_compression_and_writes_verified_report(self):
        for compression, flags in (("none", ["-Z"]), ("any", ["-z", "any"])):
            output = self.root / compression
            with patch.object(benchmark.subprocess, "run", side_effect=self.fake_copy) as run, \
                    patch.object(benchmark.time, "perf_counter", side_effect=[100, 102, 200, 203]):
                report = benchmark.pull(self.workspace, "phone:1234", "small", output,
                                        compression, "adb with spaces")
            command = run.call_args.args[0]
            self.assertEqual(command[:4], ["adb with spaces", "-s", "phone:1234", "pull"])
            self.assertEqual(command[4:-2], flags)
            self.assertEqual(command[-2], f"/sdcard/Download/{self.manifest['fixture']}/small")
            self.assertTrue(report["verified"])
            self.assertEqual(report["bytes"], 12288)
            self.assertEqual(report["transfer_seconds"], 2)
            self.assertEqual(report["verification_seconds"], 3)
            self.assertNotIn("phone:1234", json.dumps(report))
            self.assertEqual(json.loads((output / "result.json").read_text()), report)

    def test_oversized_manifest_and_symlink_copy_root_are_rejected(self):
        (self.workspace / "manifest.json").write_bytes(b" " * (2 * benchmark.MIB + 1))
        with self.assertRaisesRegex(ValueError, "exceeds"):
            benchmark.load_manifest(self.workspace)
        link = self.root / "link"
        try:
            link.symlink_to(self.source / "small", target_is_directory=True)
        except OSError:
            self.skipTest("Symlink creation unavailable")
        with self.assertRaisesRegex(ValueError, "real workload directory"):
            benchmark.verify_copy(self.manifest, "small", link)

    def test_failed_timed_out_cancelled_or_corrupt_pull_has_no_success_report(self):
        failures = [subprocess.CalledProcessError(1, "fake-adb"),
                    subprocess.TimeoutExpired("fake-adb", 600), KeyboardInterrupt()]
        for index, error in enumerate(failures):
            output = self.root / f"failed-{index}"
            with patch.object(benchmark.subprocess, "run", side_effect=error):
                with self.assertRaises(type(error)):
                    benchmark.pull(self.workspace, "device", "small", output)
            self.assertFalse((output / "result.json").exists())
        with patch.object(benchmark.subprocess, "run"):
            with self.assertRaises(ValueError):
                benchmark.pull(self.workspace, "device", "small", self.output)
        self.assertFalse((self.output / "result.json").exists())

    def test_bad_serial_existing_destination_or_corrupt_source_never_calls_adb(self):
        with patch.object(benchmark.subprocess, "run") as run:
            for serial in ("", " device", "device\n", "dev\x00ice"):
                with self.assertRaises(ValueError):
                    benchmark.pull(self.workspace, serial, "small", self.output)
            self.output.mkdir()
            sentinel = self.output / "keep"
            sentinel.write_text("keep")
            with self.assertRaises(FileExistsError):
                benchmark.pull(self.workspace, "device", "small", self.output)
            self.assertEqual(sentinel.read_text(), "keep")
            (self.source / "small" / "file-000000.bin").write_bytes(b"broken")
            with self.assertRaises(ValueError):
                benchmark.pull(self.workspace, "device", "small", self.root / "unused")
            run.assert_not_called()

    def test_manual_timing_reports_only_verified_bytes_and_finite_positive_time(self):
        for seconds in (0, -1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                benchmark.result(self.manifest, "large", self.source / "large", seconds, "mtp", "unknown")
        report = benchmark.result(self.manifest, "large", self.source / "large", 2, "mtp", "unknown")
        self.assertEqual(report["mib_per_second"], 0.5)

    def test_offline_cli_verification_success_and_failure(self):
        command = [sys.executable, str(Path(benchmark.__file__)), "verify", str(self.workspace),
                   "--workload", "small", "--copy", str(self.source / "small"),
                   "--seconds", "1", "--backend", "local-control"]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(json.loads(completed.stdout)["verified"])
        (self.source / "small" / "file-000000.bin").unlink()
        completed = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, "")
        self.assertIn("No verified result", completed.stderr)


if __name__ == "__main__":
    unittest.main()
