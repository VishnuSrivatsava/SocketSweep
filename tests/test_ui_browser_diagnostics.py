"""UI harness diagnostics without opening a browser, Tauri or ADB."""
import io
from queue import Empty, Queue
import subprocess
import unittest
from unittest.mock import Mock, patch

import check_scan_ui as harness


class UiBrowserDiagnosticsTests(unittest.TestCase):
    def test_queued_report_wins_over_a_browser_exit(self):
        reports = Queue()
        value = {"fixture": "last", "passed": True}
        reports.put(value)
        process = Mock()
        process.poll.return_value = 0
        self.assertEqual(harness.wait_for_report(reports, process, "last"), value)
        process.poll.assert_not_called()

    def test_browser_exit_is_reported_without_waiting_for_full_deadline(self):
        for status in (0, 7, -15):
            with self.subTest(status=status):
                reports = Mock()
                reports.get.side_effect = Empty
                process = Mock()
                process.poll.return_value = status
                with self.assertRaisesRegex(RuntimeError, f"status {status}.*device-discovery"):
                    harness.wait_for_report(reports, process, "device-discovery")
                self.assertEqual(reports.get.call_count, 1)
                self.assertLessEqual(reports.get.call_args.kwargs["timeout"], 0.1)

    def test_live_browser_times_out_with_expected_fixture(self):
        process = Mock()
        process.poll.return_value = None
        with self.assertRaisesRegex(TimeoutError, "waiting for scan-ui"):
            harness.wait_for_report(Queue(), process, "scan-ui", timeout=0)

    def test_empty_queue_does_not_reset_the_deadline(self):
        process = Mock()
        process.poll.return_value = None
        reports = Mock()
        reports.get.side_effect = Empty
        with patch.object(harness, "monotonic", side_effect=[0, 1, 39, 39.5, 40]):
            with self.assertRaises(TimeoutError):
                harness.wait_for_report(reports, process, "scan-ui")
        self.assertEqual(reports.get.call_count, 2)

    def test_http_activity_keeps_only_first_and_latest_bounded_paths(self):
        activity = harness.HttpActivity()
        self.assertEqual(activity.snapshot()["http_requests"], 0)
        self.assertIsNone(activity.snapshot()["first_request"])
        activity.record("GET", "/fixture.html?omit-query", 200)
        for index in range(1000):
            activity.record("GET", "/" + str(index) + "x" * 1000, 404)
        state = activity.snapshot()
        self.assertEqual(state["http_requests"], 1001)
        self.assertEqual(state["first_request"]["path"], "/fixture.html")
        self.assertTrue(state["latest_request"]["path"].startswith("/999"))
        self.assertEqual(len(state["latest_request"]["path"]), 256)
        self.assertEqual(state["latest_request"]["status"], 404)
        self.assertGreaterEqual(state["elapsed_ms"], 0)

    def test_log_tail_is_byte_bounded_and_tolerates_invalid_utf8(self):
        stream = io.BytesIO(b"not retained" * 1000 + b"\xff" * 3000)
        self.assertEqual(harness.log_tail(stream), "\ufffd" * 3000)
        self.assertEqual(harness.log_tail(io.BytesIO(b"short")), "short")

    def test_browser_version_probe_is_bounded_and_failure_is_diagnostic(self):
        with patch.object(harness.subprocess, "run") as run:
            run.return_value = Mock(returncode=0, stdout="Browser fixture" + "x" * 1000, stderr="")
            self.assertEqual(len(harness.browser_version("chosen-browser")), 512)
            self.assertEqual(run.call_args.args[0], ["chosen-browser", "--version"])
            self.assertEqual(run.call_args.kwargs["timeout"], 5)
            for error in (OSError("not executable"), subprocess.TimeoutExpired("browser", 5)):
                run.side_effect = error
                self.assertIn("Version unavailable", harness.browser_version("chosen-browser"))
