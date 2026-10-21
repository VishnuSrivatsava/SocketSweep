"""Offline wrapper tests: Cargo and ADB are never executed."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import benchmark_device_scan as benchmark


class DeviceScanBenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.adb = self.root / "fake-adb"
        self.adb.touch()
        self.daemon = self.root / "fake-daemon"
        self.daemon.write_bytes(b"immutable fixture")
        self.output = self.root / "results"

    def run_benchmark(self, **kwargs):
        return benchmark.benchmark("explicit-device", output=self.output,
                                   adb=self.adb, daemon=self.daemon, **kwargs)

    def test_invalid_inputs_and_existing_output_never_launch(self):
        with patch.object(benchmark.subprocess, "Popen") as launch:
            for serial in ("", "with space", "x\n", "x\0"):
                with self.assertRaises(ValueError):
                    benchmark.benchmark(serial)
            for root in ("relative", "/x\n", "/x\0", "/" + "ü" * 8192):
                with self.assertRaises(ValueError):
                    self.run_benchmark(root=root)
            self.assertFalse(self.output.exists())
            self.output.mkdir()
            sentinel = self.output / "keep"
            sentinel.write_bytes(b"unchanged")
            with self.assertRaises(FileExistsError):
                self.run_benchmark()
            self.assertEqual(sentinel.read_bytes(), b"unchanged")
            launch.assert_not_called()

    def test_success_uses_release_exact_opt_in_and_immutable_artifact(self):
        child = None

        def launch(command, **kwargs):
            nonlocal child
            self.assertIn("--release", command)
            self.assertEqual(command[-5:], [benchmark.TEST, "--", "--ignored", "--exact", "--nocapture"])
            env = kwargs["env"]
            self.assertEqual(env["SOCKETSWEEP_DEVICE_BENCH"], "1")
            self.assertEqual(env["SOCKETSWEEP_BENCH_SERIAL"], "explicit-device")
            self.assertEqual(env["SOCKETSWEEP_BENCH_ROOT"], "/sdcard")
            artifact = Path(env["SOCKETSWEEP_BENCH_DAEMON"])
            self.assertNotEqual(artifact, self.daemon)
            self.assertEqual(artifact.read_bytes(), b"immutable fixture")
            self.daemon.write_bytes(b"new build")
            report = {"verified": True, "medians": [{"workers": 1, "scan_ms": 1, "stream_wall_ms": 2}]}
            (self.output / "measurements.json").write_text(json.dumps(report), encoding="utf-8")
            from unittest.mock import Mock
            child = Mock(stdin=io.BytesIO())
            child.wait.return_value = 0
            return child

        with patch.object(benchmark.subprocess, "Popen", side_effect=launch):
            self.run_benchmark(root="/sdcard///")
        self.assertTrue(child.stdin.closed)
        result = json.loads((self.output / "result.json").read_text())
        self.assertEqual(result["daemon_sha256"], hashlib.sha256(b"immutable fixture").hexdigest())

    def test_failed_or_unverified_run_has_no_result(self):
        from unittest.mock import Mock
        for status in (1, 0):
            with self.subTest(status=status):
                self.output = self.root / f"results-{status}"

                def launch(*args, **kwargs):
                    (self.output / "measurements.json").write_text('{"verified":false}')
                    child = Mock(stdin=io.BytesIO())
                    child.wait.return_value = status
                    return child

                with patch.object(benchmark.subprocess, "Popen", side_effect=launch):
                    with self.assertRaises((ValueError, RuntimeError)):
                        self.run_benchmark()
                self.assertFalse((self.output / "result.json").exists())

    def test_interrupt_closes_cancellation_pipe_and_waits_for_cleanup(self):
        from unittest.mock import Mock
        child = Mock(stdin=io.BytesIO())

        def wait(**kwargs):
            if not kwargs:
                raise KeyboardInterrupt
            self.assertTrue(child.stdin.closed)
            self.assertEqual(kwargs, {"timeout": 90})
            return 0

        child.wait.side_effect = wait
        with patch.object(benchmark.subprocess, "Popen", return_value=child):
            with self.assertRaises(KeyboardInterrupt):
                self.run_benchmark()
        child.terminate.assert_not_called()
        self.assertFalse((self.output / "result.json").exists())
