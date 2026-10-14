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

if sys.platform not in ("darwin", "linux"):
    sys.exit("Headless UI harness supports macOS and Linux")

REPO = Path(__file__).resolve().parents[1]
chrome = (sys.argv[1] if len(sys.argv) > 1 else
          shutil.which('chromium') or shutil.which('google-chrome') or
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
if not Path(chrome).is_file():
    sys.exit('Chrome/Chromium missing; pass its executable as the first argument')
reports = Queue()
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
    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        if self.path != '/report' or not 0 < length < 64 * 1024:
            self.send_error(400)
            return
        value = json.loads(self.rfile.read(length))
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
            rollupOptions: { input: ['tests/toast_lifecycle_fixture.html', 'tests/log_history_fixture.html'] },
        }});
    ''', str(work / 'site')], cwd=REPO, check=True, timeout=60)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(work / 'site')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with (work / 'chrome.log').open('w+') as log:
            process = subprocess.Popen([chrome, '--headless', '--disable-gpu', '--no-first-run',
                '--use-mock-keychain', '--password-store=basic', '--enable-logging=stderr',
                '--disable-background-networking', '--disable-extensions',
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
                f'--window-size={os.environ.get("UI_TEST_WINDOW", "1280,1000")}',
                f'--force-device-scale-factor={os.environ.get("UI_TEST_SCALE", "1")}',
                f'--user-data-dir={work / "profile"}', f'http://127.0.0.1:{server.server_port}'],
                stdout=log, stderr=log, start_new_session=True)
            try:
                for expected in ('scan-ui', 'toast-lifecycle', 'log-history'):
                    value = reports.get(timeout=40)
                    print(json.dumps(value, indent=2))
                    if value.get('fixture') != expected or not value['passed']:
                        sys.exit(1)
            except Empty:
                log.seek(0)
                sys.exit('Headless browser timed out: ' + log.read()[-3000:])
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
