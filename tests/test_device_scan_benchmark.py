"""Offline wrapper tests: Cargo and ADB are never executed."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import benchmark_device_scan as benchmark


FIXTURE = b"\x7fELF\x02\x01" + bytes(12) + (183).to_bytes(2, "little") + b"immutable fixture"


def verified_report():
    return {"verified": True, "medians": [
        {"workers": workers, "samples": 5, "scan_ms": 1, "stream_wall_ms": 2}
        for workers in (1, 2, 4, 8)
    ]}


class DeviceScanBenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.adb = self.root / "fake-adb"
        self.adb.touch()
        self.daemon = self.root / "fake-daemon"
        self.daemon.write_bytes(FIXTURE)
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
            self.assertEqual(env["SOCKETSWEEP_BENCH_ABI"], "arm64-v8a")
            artifact = Path(env["SOCKETSWEEP_BENCH_DAEMON"])
            self.assertNotEqual(artifact, self.daemon)
            self.assertEqual(artifact.read_bytes(), FIXTURE)
            self.daemon.write_bytes(b"new build")
            (self.output / "measurements.json").write_text(json.dumps(verified_report()), encoding="utf-8")
            from unittest.mock import Mock
            child = Mock(stdin=io.BytesIO())
            child.wait.return_value = 0
            return child

        with patch.object(benchmark.subprocess, "Popen", side_effect=launch):
            self.run_benchmark(root="/sdcard///")
        self.assertTrue(child.stdin.closed)
        result = json.loads((self.output / "result.json").read_text())
        self.assertEqual(result["daemon_abi"], "arm64-v8a")
        self.assertEqual(result["daemon_sha256"], hashlib.sha256(FIXTURE).hexdigest())

    def test_elf_architecture_is_read_from_bytes_and_bad_snapshots_never_launch(self):
        for elf_class, machine, expected in [
            (1, 40, "armeabi-v7a"), (1, 3, "x86"), (2, 62, "x86_64"),
        ]:
            self.daemon.write_bytes(b"\x7fELF" + bytes([elf_class, 1]) + bytes(12) + machine.to_bytes(2, "little"))
            self.assertEqual(benchmark.daemon_abi(self.daemon), expected)
        for index, invalid in enumerate([b"bad", b"\x7fELF" + bytes(16),
                                        b"\x7fELF\x02\x01" + bytes(12) + (40).to_bytes(2, "little")]):
            self.daemon.write_bytes(invalid)
            self.output = self.root / f"invalid-{index}"
            with patch.object(benchmark.subprocess, "Popen") as launch:
                with self.assertRaises(ValueError):
                    self.run_benchmark()
                launch.assert_not_called()
                self.assertFalse((self.output / "result.json").exists())

    def test_failed_or_invalid_run_has_no_result(self):
        from unittest.mock import Mock
        invalid_reports = [
            ("cargo-failure", 1, verified_report()),
            ("unverified", 0, {"verified": False}),
            ("wrong-shape", 0, []),
            ("missing-medians", 0, {"verified": True}),
            ("missing-workers", 0, {"verified": True, "medians": []}),
        ]
        for field, value in [("workers", 2), ("samples", 4), ("scan_ms", -1),
                             ("stream_wall_ms", float("nan")), ("scan_ms", True)]:
            report = verified_report()
            report["medians"][0][field] = value
            invalid_reports.append((f"{field}-{value}", 0, report))
        invalid_reports.append(("invalid-json-number", 0, {**verified_report(), "runs": [float("inf")]}))
        for name, status, report in invalid_reports:
            with self.subTest(name=name):
                self.output = self.root / f"results-{name}"

                def launch(*args, **kwargs):
                    (self.output / "measurements.json").write_text(json.dumps(report), encoding="utf-8")
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
