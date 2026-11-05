#!/usr/bin/env python3
"""Check the built UI, toasts and log history in Chromium, never ADB/Tauri.

Run npm run build first. Uses installed Chrome/Chromium, no added packages.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from queue import Empty, Queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from time import monotonic


def browser_version(chrome):
    try:
        result = subprocess.run([chrome, '--version'], capture_output=True, text=True,
                                encoding='utf-8', errors='replace', timeout=5)
        return f"exit {result.returncode}: {(result.stdout + result.stderr).strip()}"[:512]
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"Version unavailable: {error}"[:512]


# The first report additionally budgets one-time browser startup on fresh CI
# runners: profile creation, font cache and driver probing exceeded the
# per-fixture deadline before any report in #78. The execution deadline for
# every later report is unchanged, and assertions never move.
STARTUP_FIXTURE = 'device-discovery'
REPORT_TIMEOUT = 40
STARTUP_TIMEOUT = 120


def report_timeout(expected):
    return STARTUP_TIMEOUT if expected == STARTUP_FIXTURE else REPORT_TIMEOUT


def wait_for_report(reports, process, expected, timeout=None):
    if timeout is None:
        timeout = report_timeout(expected)
    deadline = monotonic() + timeout
    while True:
        try:
            # Consume an already queued report even if the browser has exited.
            return reports.get(timeout=min(0.1, max(0, deadline - monotonic())))
        except Empty:
            status = process.poll()
            if status is not None:
                raise RuntimeError(f"Browser exited with status {status} while waiting for {expected}")
            if monotonic() >= deadline:
                raise TimeoutError(f"Headless browser timed out after {timeout}s waiting for {expected}")


def log_tail(log):
    log.seek(0, os.SEEK_END)
    log.seek(max(0, log.tell() - 3000))
    return log.read(3000).decode('utf-8', errors='replace')


class HttpActivity:
    def __init__(self):
        self.started = monotonic()
        self.lock = threading.Lock()
        self.count = 0
        self.first = None
        self.latest = None

    def record(self, method, path, status):
        event = {"method": method, "path": path.split('?', 1)[0][:256], "status": status}
        with self.lock:
            event["elapsed_ms"] = round((monotonic() - self.started) * 1000)
            self.count += 1
            if self.first is None:
                self.first = event
            self.latest = event

    def snapshot(self):
        with self.lock:
            return {"elapsed_ms": round((monotonic() - self.started) * 1000),
                    "http_requests": self.count, "first_request": self.first, "latest_request": self.latest}


def main():
    if sys.platform not in ("darwin", "linux"):
        sys.exit("Headless UI harness supports macOS and Linux")

    REPO = Path(__file__).resolve().parents[1]
    chrome = (sys.argv[1] if len(sys.argv) > 1 else
              shutil.which('chromium') or shutil.which('google-chrome') or
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not Path(chrome).is_file():
        sys.exit('Chrome/Chromium missing; pass its executable as the first argument')
    reports = Queue()
    print(json.dumps({"browser": chrome, "version": browser_version(chrome)}), flush=True)
    # Keep the production resource policy. Only the fixture's local report endpoint
    # needs an extra connect-src origin; native IPC remains mocked.
    csp = json.loads((REPO / 'src-tauri/tauri.conf.json').read_text())['app']['security']['csp']
    csp = csp.replace('connect-src ', "connect-src 'self' ")

    class Handler(SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header('Content-Security-Policy', csp)
            super().end_headers()
        def log_message(self, *args):
            pass
        def log_request(self, code="-", size="-"):
            activity.record(self.command, self.path, code)
        def do_POST(self):
            length = int(self.headers.get('Content-Length', '0'))
            if self.path not in ('/report', '/keyboard') or not 0 < length < 64 * 1024:
                self.send_error(400)
                return
            value = json.loads(self.rfile.read(length))
            if self.path == '/keyboard':
                if not isinstance(value, dict) or value.get('key') not in (
                        'Enter', 'Tab', 'Shift+Tab', 'Escape', 'Home', 'End',
                        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'):
                    self.send_error(400)
                    return
                try:
                    # Node 20 exposes its built-in WebSocket under this flag.
                    subprocess.run(['node', '--experimental-websocket', str(REPO / 'tests/browser_keys.mjs'),
                                    str(work / 'profile/DevToolsActivePort'), value['key']],
                                   capture_output=True, text=True, check=True, timeout=5)
                except (subprocess.SubprocessError, OSError) as error:
                    self.send_error(500, str(error)[:256])
                    return
                self.send_response(200)
                self.end_headers()
                return
            self.send_response(200)
            self.end_headers()
            reports.put(value)

    with tempfile.TemporaryDirectory(prefix='socketsweep-ui-test-') as directory:
        work = Path(directory)
        shutil.copytree(REPO / 'dist', work / 'site')
        for name in ('inter-OFL.txt', 'jetbrainsmono-OFL.txt'):
            source = REPO / 'public/font-licenses' / name
            bundled = work / 'site/font-licenses' / name
            assert bundled.read_bytes() == source.read_bytes(), 'Bundled font license differs'
        shutil.copy(REPO / 'tests/scan_ui_fixture.js', work / 'site/fixture.js')
        index = work / 'site/index.html'
        html = index.read_text().replace('<head>', '<head><script src="/fixture.js"></script>')
        index.write_text(html)
        # Compile the actual UI components with the installed Vite/React tooling.
        # The isolated fixture stays in this temporary site, never the shipped dist.
        subprocess.run(['node', '--input-type=module', '-e', '''
            import { build } from 'vite';
            await build({ logLevel: 'error', build: {
                outDir: process.argv[1], emptyOutDir: false,
                rollupOptions: { input: ['tests/toast_lifecycle_fixture.html', 'tests/log_history_fixture.html', 'tests/folder_expansion_fixture.html'] },
            }});
        ''', str(work / 'site')], cwd=REPO, check=True, timeout=60)
        # A separate development-React bundle verifies StrictMode's double effect;
        # the production UI and other fixtures retain their production bundles.
        subprocess.run(['node', '--input-type=module', '-e', """
            import { build } from 'vite';
            await build({ logLevel: 'error', define: { 'process.env.NODE_ENV': '"development"' }, build: {
                outDir: process.argv[1], emptyOutDir: false,
                rollupOptions: { input: 'tests/device_discovery_fixture.html' },
            }});
        """, str(work / 'site')], cwd=REPO, check=True, timeout=60)
        activity = HttpActivity()
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(work / 'site')))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with (work / 'chrome.log').open('w+b') as log:
                process = subprocess.Popen([chrome, '--headless', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
                    '--use-mock-keychain', '--password-store=basic', '--enable-logging=stderr',
                    '--disable-background-networking', '--disable-extensions',
                    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
                    f'--window-size={os.environ.get("UI_TEST_WINDOW", "1280,1000")}',
                    f'--force-device-scale-factor={os.environ.get("UI_TEST_SCALE", "1")}',
                    f'--user-data-dir={work / "profile"}', f'http://127.0.0.1:{server.server_port}/tests/device_discovery_fixture.html'],
                    stdout=log, stderr=log, start_new_session=True)
                try:
                    for expected in ('device-discovery', 'folder-expansion', 'scan-ui', 'toast-lifecycle', 'log-history'):
                        value = wait_for_report(reports, process, expected)
                        print(json.dumps(value, indent=2), flush=True)
                        if value.get('fixture') != expected or not value['passed']:
                            sys.exit(1)
                except (TimeoutError, RuntimeError) as error:
                    context = {"waiting_for": expected, "browser_status": process.poll(), **activity.snapshot()}
                    sys.exit(f"{error}\n{json.dumps(context)}\nBrowser log tail:\n{log_tail(log)}")
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
