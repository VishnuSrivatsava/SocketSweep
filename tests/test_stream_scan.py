"""Stream contract and end-to-end daemon tests on disposable host fixtures."""
import errno
import json
import os
import socket
import struct
from test_daemon import DaemonHarness

MAX_FRAME = 128 * 1024

def exact(client, size):
    data = bytearray()
    while len(data) < size:
        piece = client.recv(size - len(data))
        if not piece:
            raise AssertionError('Truncated stream')
        data.extend(piece)
    return bytes(data)

def frame(client):
    size, = struct.unpack('!I', exact(client, 4))
    if not 0 < size <= MAX_FRAME:
        raise AssertionError('Unbounded frame')
    value = json.loads(exact(client, size))
    return dict(type=value["type"], **value["data"]), size + 4

class StreamScanTests(DaemonHarness):
    def connect_scan(self, root=None):
        client = socket.create_connection(('127.0.0.1', self.port), timeout=3)
        client.sendall(f'AUTH {self.token}\nSCAN_STREAM {root or self.root}\n'.encode())
        return client

    def collect(self, root=None):
        with self.connect_scan(root) as client:
            started, byte_count = frame(client)
            if started['type'] == 'error':
                return started, {}, []
            self.assertEqual(started['type'], 'started')
            self.assertEqual(started['stream_version'], 1)
            entries, batches = {}, []
            while True:
                item, count = frame(client)
                if item['type'] == 'error':
                    return item, entries, batches
                if item['type'] == 'done':
                    self.assertEqual(item['bytes_sent'], byte_count)
                    self.assertEqual(client.recv(1), b'')
                    break
                self.assertEqual(item['type'], 'entries')
                self.assertTrue(0 < len(item['entries']) <= 128)
                batches.append(item['entries'])
                for entry in item['entries']:
                    self.assertEqual(entry['id'], len(entries))
                    parent = entry['parent']
                    if parent is None:
                        self.assertEqual(entry['id'], 0)
                        path = started['root']
                    else:
                        self.assertIn(parent, entries)
                        self.assertEqual(entries[parent]['kind'], 'directory')
                        path = entries[parent]['path'].rstrip('/') + '/' + entry['name']
                    entries[entry['id']] = dict(entry, path=path)
                byte_count += count
            self.assertEqual(item['total_files'], sum(e['counted'] and e['kind'] == 'file' for e in entries.values()))
            self.assertEqual(item['total_dirs'], sum(e['counted'] and e['kind'] == 'directory' for e in entries.values()))
            self.assertEqual(item['total_size'], sum(e['size'] for e in entries.values()))
            return item, entries, batches

    def test_scan_root_info_requires_success_and_tracks_retargeted_aliases(self):
        effective_read_only = self.read_only or os.geteuid() == 0
        self.assertEqual(self.request('SCAN_ROOT_INFO')['status'], 'error')
        alias = self.root.parent / 'scan-alias'
        alias.symlink_to(self.root, target_is_directory=True)
        done, entries, _ = self.collect(alias)
        self.assertEqual(done['type'], 'done')
        info = self.request('SCAN_ROOT_INFO')
        self.assertEqual(info, dict(status='ok', version=1, scan_root=entries[0]['path'],
                                   canonical_root=str(self.root.resolve()), read_only=effective_read_only))
        outside = self.root.parent / 'other-root'
        outside.mkdir()
        alias.unlink()
        alias.symlink_to(outside, target_is_directory=True)
        if not effective_read_only:
            self.assertEqual(self.request('SCAN_ROOT_INFO')['status'], 'error')
        # Read-only traversal pins its resolved original path, so changing the
        # caller's alias does not change which directory that scan describes.
        done, _, _ = self.collect(alias)
        self.assertEqual(done['type'], 'done')
        self.assertEqual(self.request('SCAN_ROOT_INFO')['canonical_root'], str(outside.resolve()))
        self.collect(outside / 'missing')
        self.assertEqual(self.request('SCAN_ROOT_INFO')['status'], 'error')

    def test_scan_root_info_preserves_escaped_canonical_names_and_exact_verb(self):
        target = self.root.parent / 'target \" with space'
        target.mkdir()
        alias = self.root.parent / 'plain-alias'
        alias.symlink_to(target, target_is_directory=True)
        self.assertEqual(self.collect(alias)[0]['type'], 'done')
        self.assertEqual(self.request('SCAN_ROOT_INFO')['canonical_root'], str(target.resolve()))
        for command in ['SCAN_ROOT_INFOX', 'SCAN_ROOT_INFO /', 'SCAN_ROOT_INFO ']:
            self.assertEqual(self.request(command)['status'], 'error')

    def test_stream_requires_authentication_before_any_frames(self):
        for prefix in ["", f"AUTH {'0' * 64}\n"]:
            result = self.raw_request(f"{prefix}SCAN_STREAM {self.root}\n".encode())
            self.assertEqual(result["status"], "error")
            self.assertIn("Authentication", result["message"])
        self.assertEqual(self.request("PING")["status"], "ok")

    def test_stream_matches_legacy_tree_and_keeps_frames_bounded(self):
        for d in range(80):
            directory = self.root / f'album {d}'
            directory.mkdir()
            (directory / 'empty').mkdir()
            for f in range(12):
                (directory / f'file {f}').write_bytes(b'x' * (d + f))
        for name in [' leading trailing ', 'line\nquote"', '.hidden', '写真']:
            (self.root / name).write_bytes(b'1234567')
        os.link(self.root / '.hidden', self.root / 'hard-link')
        (self.root / 'symlink').symlink_to(self.root / '.hidden')
        os.mkfifo(self.root / 'fifo')
        legacy = self.scan()
        done, entries, batches = self.collect()
        for key in ['total_files', 'total_dirs', 'total_size', 'errors', 'skipped', 'scan_threads']:
            self.assertEqual(done[key], legacy[key], key)
        expected = {}
        def flatten(node):
            expected[node['path']] = (node['type'], node['size'])
            for child in node.get('children', []):
                flatten(child)
        flatten(legacy['tree'])
        actual = {}
        for entry in reversed(list(entries.values())):
            kind = 'directory' if entry['kind'] == 'directory' else 'file'
            size = entry['size'] + sum(s for p, (_, s) in actual.items() if p.rsplit('/', 1)[0] == entry['path'])
            actual[entry['path']] = (kind, size)
        self.assertEqual(actual, expected)
        self.assertGreater(len(batches), 5)

    def test_non_utf8_filename_bytes_are_not_silently_replaced(self):
        path = os.fsencode(self.root) + b'/nonutf-\xff'
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except OSError as error:
            if error.errno in (errno.EILSEQ, errno.EINVAL):
                self.skipTest('Filesystem does not support non-UTF-8 filenames')
            raise
        os.close(fd)
        with self.connect_scan() as client:
            found = False
            while True:
                size, = struct.unpack('!I', exact(client, 4))
                self.assertTrue(0 < size <= MAX_FRAME)
                payload = exact(client, size)
                if b'nonutf-\xff' in payload:
                    # Stream v1 has no raw-byte filename field. Rust must reject
                    # this JSON rather than replace bytes and publish a wrong path.
                    with self.assertRaises(UnicodeDecodeError):
                        payload.decode('utf-8')
                    found = True
                    break
                if json.loads(payload)['type'] in ('done', 'error'):
                    break
            self.assertTrue(found)
        self.assertEqual(self.request('PING')['status'], 'ok')

    def test_root_and_first_entry_arrive_before_scan_completion(self):
        for i in range(5000):
            (self.root / str(i)).write_bytes(b'123')
        with self.connect_scan() as client:
            start, _ = frame(client)
            root, _ = frame(client)
            entry, _ = frame(client)
            self.assertEqual(start['type'], 'started')
            self.assertEqual(root['entries'][0]['id'], 0)
            self.assertEqual(entry['type'], 'entries')
            self.assertEqual(entry['entries'][0]['id'], 1)
            self.assertEqual(entry['entries'][0]['size'], 3)
        # Closing while consuming partial results cancels traversal and leaves
        # neither a successful scan root nor a stuck daemon.
        result = self.request(f'DELETE {self.root / "0"}')
        self.assertEqual(result['status'], 'error')
        self.assertTrue((self.root / '0').exists())
        self.assertEqual(self.request('PING')['status'], 'ok')

    def test_failed_stream_clears_previous_delete_root(self):
        (self.root / 'keep').write_text('keep')
        self.scan()
        result, _, _ = self.collect(self.root / 'missing')
        self.assertEqual(result['type'], 'error')
        self.assertEqual(self.request(f'DELETE {self.root / "keep"}')['status'], 'error')

    def test_success_retains_secure_deletion_or_root_read_only(self):
        (self.root / 'target').write_bytes(b'123')
        done, _, _ = self.collect()
        self.assertEqual(done['type'], 'done')
        result = self.request(f'DELETE {self.root / "target"}')
        self.assertEqual(result['status'], 'error' if self.read_only or os.geteuid() == 0 else 'ok')
        self.assertEqual(self.request(f'DELETE {self.root}')['status'], 'error')

    def test_stream_rejects_relative_root(self):
        result, _, _ = self.collect('relative-root')
        self.assertEqual(result['type'], 'error')

    def test_depth_limit_preserves_counts_and_reports_error(self):
        directory = self.root
        for level in range(67):
            (directory / 'file').write_bytes(b'x')
            directory = directory / 'next'
            directory.mkdir()
        legacy = self.scan()
        done, _, _ = self.collect()
        for key in ['total_files', 'total_dirs', 'total_size', 'errors', 'skipped']:
            self.assertEqual(done[key], legacy[key], key)
        self.assertEqual(done['errors'], 1)

    def test_extra_command_bytes_abort_the_stream(self):
        with socket.create_connection(('127.0.0.1', self.port), timeout=3) as client:
            client.sendall(f'AUTH {self.token}\nSCAN_STREAM {self.root}\nSHUTDOWN\n'.encode())
            try:
                self.assertEqual(client.recv(1), b'')
            except ConnectionResetError:
                pass  # unread extra command bytes may cause TCP RST
        self.assertEqual(self.request('PING')['status'], 'ok')

class ReadOnlyStreamScanTests(StreamScanTests):
    read_only = True
    scan_threads = 8
