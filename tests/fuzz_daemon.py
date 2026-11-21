"""Adversarial harness against the host-built SocketSweep daemon.

Phase 1 — protocol fuzz: malformed, split, oversized, CR/NUL-injected,
non-UTF-8 and random-byte input on the AUTH/command wire. The daemon must
never crash, hang beyond its own timeouts, or emit a non-JSON-line response
where a response is expected.

Phase 2 — pathological filesystem scan: JSON-hostile filenames (quotes,
backslashes, tabs, newlines, unicode), 255-byte names, 70-level nesting past
the daemon's depth cap, symlink loops, hardlinks, empty and sparse-large
files. Totals must match the created tree exactly.

Phase 3 — concurrency stress: streaming scan held open while other
connections flood PING and auth failures. The daemon must survive and shut
down cleanly.

Every phase asserts the daemon process stays alive.
"""

import json
import os
import secrets
import socket
import subprocess
import sys
import time

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}: {name}" + (f" — {detail}" if detail else ""))


def main():
    cxx = os.environ.get("CXX") or "c++"
    build = "/tmp/socketsweep-fuzz"
    os.makedirs(build, exist_ok=True)
    binary = f"{build}/daemon"
    subprocess.run([cxx, "-std=c++17", "-O2", "-pthread", "-Wall", "-Wextra",
                    "-Wpedantic", "-fno-exceptions", "-fno-rtti",
                    "engine/daemon.cpp", "-o", binary], check=True)

    token = secrets.token_hex(32)
    import shutil
    files = f"{build}/files"
    shutil.rmtree(files, ignore_errors=True)
    os.makedirs(files)
    for stale in ("token", "ready", "ready.tmp", "stderr.log"):
        try: os.remove(f"{build}/{stale}")
        except FileNotFoundError: pass
    token_path = f"{build}/token"
    with open(token_path, "w") as fh:
        fh.write(token + "\n")
    os.chmod(token_path, 0o600)

    with socket.socket() as r:
        r.bind(("127.0.0.1", 0))
        port = r.getsockname()[1]
    proc = subprocess.Popen([binary, str(port), token_path, "--session-ready", f"{build}/ready"],
                            stdin=subprocess.PIPE,  # stdin EOF = owner gone: must stay open
                            stdout=subprocess.DEVNULL, stderr=open(f"{build}/daemon-stderr.log", "w"))
    deadline = time.time() + 10
    while time.time() < deadline:
        if os.path.exists(f"{build}/ready"):
            break
        if proc.poll() is not None:
            sys.exit("daemon died during startup")
        time.sleep(0.05)
    else:
        sys.exit("daemon never became ready")

    def alive():
        return proc.poll() is None

    def stream_exchange(command, timeout=60):
        """SCAN_STREAM exchange: no half-close (the daemon refuses to stream
        to a half-closed peer); read until the daemon closes the connection."""
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
            s.settimeout(timeout)
            s.sendall(f"AUTH {token}\n{command}\n".encode())
            data = b""
            try:
                while True:
                    chunk = s.recv(65536)
                    if not chunk:
                        break
                    data += chunk
            except socket.timeout:
                pass
            return data

    def exchange(payload, timeout=8, expect_reply=True):
        """Send raw bytes; return (had_response, bytes). Never raises on EOF."""
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
                s.settimeout(timeout)
                try:
                    s.sendall(payload)
                except (BrokenPipeError, ConnectionResetError):
                    # The daemon legitimately closed a hostile connection
                    # mid-send; that is a correct rejection, not a crash.
                    return False, b"connection reset by daemon"
                try:
                    s.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                if not expect_reply:
                    return False, b""
                data = b""
                while b"\n" not in data:
                    chunk = s.recv(65536)
                    if not chunk:
                        return bool(data), data
                    data += chunk
                return True, data
        except socket.timeout as error:
            return False, str(error).encode()
        except ConnectionResetError:
            return False, b"connection reset (peer closed)"

    def valid_session_command(command, timeout=30):
        """Authenticated exchange; returns (status_dict_or_None, raw)."""
        ok, data = exchange(f"AUTH {token}\n{command}\n".encode(), timeout=timeout)
        if not ok:
            return None, data
        try:
            return json.loads(data), data
        except json.JSONDecodeError:
            return None, data

    try:
        # ── Phase 1: protocol fuzz ────────────────────────────────────────
        fuzz_payloads = [
            b"", b"\n", b"\n\n\n", b"AUTH\n", b"AUTH \n", f"AUTH {token}".encode(),
            b"AUTH " + token.encode() + b" extra\n",
            b"AUTH " + secrets.token_bytes(64).hex().encode() + b"\n",
            b"AUTH " + secrets.token_hex(31).encode() + b"\n",      # short token
            b"AUTH " + token.upper().encode() + b"\n",              # wrong case
            b"AUTH " + token.encode() + b"\r\n",                    # CR injection
            b"AUTH " + token.encode() + b"\n\x00\x00\n",            # NUL bytes
            b"AUTH " + token.encode() + b"\nSCAN /x\nGARBAGE",     # trailing garbage
            b"AUTH " + token.encode() + b"\n" + b"X" * 20000 + b"\n",   # oversize line
            b"AUTH " + token.encode() + b"\nSCAN " + b"/" * 4000 + b"\n",
            secrets.token_bytes(512),                               # pure binary
            b"\xff\xfe\x00binary\xff\n",                            # invalid UTF-8
            b"PING\nPING\nPING\n",                                  # no AUTH
            f"AUTH {token}\nPING\nPING\n".encode(),                 # double command one write
            f"AUTH {token}\nDELETE /etc/passwd\n".encode(),         # outside root
            f"AUTH {token}\nDELETE /../etc/passwd\n".encode(),      # traversal
            f"AUTH {token}\nDELETE {files}/../../etc\n".encode(),   # relative escape
            f"AUTH {token}\nSCAN \x00\x01\x02\n".encode(),          # control-char root
            f"AUTH {token}\nSCAN_STREAM \x00\n".encode(),
            f"AUTH {token}\n".encode() + b"\xff\xfe\n",                      # invalid UTF-8 command
        ]
        for i, payload in enumerate(fuzz_payloads):
            had, data = exchange(payload, timeout=8, expect_reply=bool(payload))
            check(f"fuzz[{i}] daemon alive", alive(), f"payload={payload[:48]!r}")
            if had:
                # Any reply must be single-line JSON (the daemon's only wire shape).
                ok = all(line.startswith(b"{") and line.endswith(b"}")
                         for line in data.split(b"\n") if line)
                check(f"fuzz[{i}] reply well-formed", ok, f"reply={data[:80]!r}")

        # Slow drip: one byte at a time across the 30 s idle deadline. The
        # daemon must close the connection (timeout), not hang forever.
        slow = None
        for attempt in range(9):  # sequential accept: a previous 30 s command window can hold the daemon
            try:
                slow = socket.create_connection(("127.0.0.1", port), timeout=10)
                slow.settimeout(40)
                slow.sendall(b"AUTH " + token.encode() + b"\n")
                break
            except (BrokenPipeError, ConnectionResetError, socket.timeout):
                if slow: slow.close()
                slow = None
                time.sleep(5)
        if slow is None:
            raise RuntimeError("could not establish slow-drip connection")
        time.sleep(31)  # past RECV_TIMEOUT_SEC
        # Past the 30 s idle deadline the daemon must have torn the
        # connection down: any attempt to continue must fail — never yield
        # a valid response after the deadline.
        enforced = False
        detail = ""
        try:
            slow.sendall(b"PING\n")
            slow.settimeout(5)
            got = slow.recv(4096)
            detail = f"got={got[:40]!r}"
            enforced = b"pong" not in got
        except (BrokenPipeError, ConnectionResetError) as error:
            enforced = True
            detail = f"connection torn down: {error}"
        except socket.timeout:
            enforced = False
            detail = "recv hung past deadline"
        slow.close()
        check("slow drip: deadline enforced, no post-timeout response", enforced, detail)
        check("fuzz phase: daemon alive", alive())

        # ── Phase 2: pathological filesystem scan ─────────────────────────
        tree = f"{files}/tree"
        os.makedirs(f"{tree}/sub", exist_ok=True)
        names = [
            'quote".bin', "back\\slash.bin", '{"json":"injected"}', "tab\tname.bin",
            "new\nline.txt", "emoji-📱🔥.dat", "تست-عربي.bin", "组合字",
            "a" * 255, "w" * 243 + "-é✓.bin", ".hidden", "UPPER.TXT",
        ]
        for name in names:
            with open(f"{tree}/sub/{name}", "wb") as fh:
                fh.write(b"x" * 7)
        # depth 70: past the daemon's 64-level cap
        deep = tree
        for level in range(70):
            deep = f"{deep}/d"
            os.makedirs(deep, exist_ok=True)
        with open(f"{deep}/bottom.bin", "wb") as fh:
            fh.write(b"deep")
        # symlink loop + symlink out + hardlink + empty + sparse
        os.symlink(f"{tree}/sub", f"{tree}/loop-a")
        os.symlink(f"{tree}/loop-a", f"{tree}/loop-b")
        os.symlink("/etc", f"{tree}/to-etc")
        os.link(f"{tree}/sub/{names[0]}", f"{tree}/hardlink.bin")
        open(f"{tree}/empty.bin", "wb").close()
        with open(f"{tree}/sparse.bin", "wb") as fh:
            fh.truncate(10 * 1024 * 1024)

        expect_files = len(names) + 3  # hardlink + empty + sparse (bottom.bin sits past the depth cap)
        expect_bytes = 7 * (len(names) + 1) + 10 * 1024 * 1024  # hardlink carries the same 7 bytes
        header, raw = None, b""
        ok, data = exchange(f"AUTH {token}\nSCAN {tree}\n".encode(), timeout=120)
        if ok:
            try:
                header = json.loads(data)
            except json.JSONDecodeError:
                header = None
        if header is None:
            # SCAN always sends one JSON line; fall back to the raw buffer
            _, raw = exchange(f"AUTH {token}\nSCAN {tree}\n".encode(), timeout=120)
        if header and header.get("status") == "ok":
            check("pathological scan: exact file count", header["total_files"] == expect_files,
                  f"got {header['total_files']}, want {expect_files}")
            check("pathological scan: exact byte total",
                  header["total_size"] == expect_bytes,
                  f"got {header['total_size']}, want {expect_bytes}")
            check("pathological scan: zero errors or depth-capped only",
                  header["errors"] in (0, 1), f"errors={header['errors']} skipped={header['skipped']}")
            found = set()
            pending = [header["tree"]]
            while pending:
                node = pending.pop()
                found.add(node["name"])
                pending.extend(node.get("children", []))
            check("pathological scan: hostile names survived JSON round-trip",
                  {'quote".bin', "emoji-📱🔥.dat", "new\nline.txt", "back\\slash.bin"} <= found,
                  f"found {len(found)} distinct names")
            check("pathological scan: symlinks excluded",
                  not {"loop-a", "loop-b", "to-etc"} & found)
            check("pathological scan: depth cap did not crash", alive())
        else:
            check("pathological scan completed", False, f"header={header} raw={raw[:200]!r}")

        # SCAN_STREAM over the same tree: decoder must accept every frame.
        # No half-close: the daemon refuses to stream to a half-closed peer.
        stream = stream_exchange(f"SCAN_STREAM {tree}")
        check("pathological stream completed", b'"type":"done"' in stream,
              f"tail={stream[-120:]!r}")
        check("stream phase: daemon alive", alive())

        # ── Phase 3: concurrency stress ───────────────────────────────────
        import threading
        stop_flag = False
        ping_errors = []

        def pinger():
            while not stop_flag:
                ok, data = exchange(f"AUTH {token}\nPING\n".encode(), timeout=10)
                if ok and b"pong" not in data:
                    ping_errors.append(data[:80])

        flood = [threading.Thread(target=pinger, daemon=True) for _ in range(6)]
        for t in flood:
            t.start()
        big = f"{files}/big-tree"
        os.makedirs(f"{big}/w", exist_ok=True)
        for i in range(2000):
            with open(f"{big}/w/f{i}.bin", "wb") as fh:
                fh.write(b"y" * 64)
        data = stream_exchange(f"SCAN_STREAM {big}")
        check("stress: scan completed under ping flood", b'"type":"done"' in data,
              f"tail={data[-80:]!r}")
        stop_flag = True
        for t in flood:
            t.join(timeout=15)
        check("stress: no malformed PING replies", not ping_errors, str(ping_errors[:2]))

        auth_failures = []
        for i in range(50):
            ok, data = exchange(b"AUTH " + b"0" * 64 + b"\nPING\n", timeout=5)
            auth_failures.append(ok and b"Authentication failed" in data)
        check("stress: 50 auth-failure floods all rejected cleanly", all(auth_failures))

        status, _ = valid_session_command("SHUTDOWN", timeout=15)
        proc.stdin.close()  # owner EOF: the daemon exits after the protocol shutdown
        proc.wait(timeout=10)
        check("clean shutdown after all attacks", proc.returncode == 0 and alive() is False)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
