#!/usr/bin/env python3
"""Unix-only ADB fixture: private local files and a real host-built daemon.

No Android commands or real ADB executable are invoked. Forwarding is modeled
by using the host daemon's port directly and recording the requested mapping.
"""
import fcntl
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import time

config = json.loads(Path(sys.argv[1]).read_text())
args = sys.argv[2:]
if args != ["devices", "-l"]:
    assert args[:2] == ["-s", config["serial"]], args
    args = args[2:]
base = Path(config["base"])
with (base / "calls.jsonl").open("a") as stream:
    stream.write(json.dumps(args) + "\n")  # the token is stdin, never logged
failure = (base / "fail").read_text().strip() if (base / "fail").exists() else ""


def fail(stage):
    if failure == stage:
        sys.exit("Injected " + stage + " failure")


def mapped(command):
    # Production session paths contain only a fixed prefix and random hex.
    return command.replace("/data/local/tmp/", str(Path(config["phone"])) + "/")


if args == ["devices", "-l"]:
    discovery = base / "devices.txt"
    print(discovery.read_text() if discovery.exists() else
          f'List of devices attached\n{config["serial"]}\tdevice model:Fixture\n')
elif args == ["features"]:
    # The CLI prints one feature per line, not the comma-delimited wire set.
    print("cmd\nshell_v2\nstat_v2" if failure != "features" else "cmd\nstat_v2")
elif args[0] == "push":
    fail("push")
    shutil.copyfile(args[1], mapped(args[2]))
elif args[0] == "shell":
    command = args[-1]
    elevated = command.startswith("su -c ")
    if elevated:
        command = shlex.split(command)[2]
    if command == "id -u":
        print("0" if elevated and failure != "root" else "2000")
    elif args[1] == "-T":
        fail("launch")
        command = shlex.split(mapped(command))
        assert command[0] == "exec"
        if failure == "handshake":
            Path(command[3]).write_text("0" * 64 + "\n")
        os.execv(command[1], command[1:])
    elif "appops set" in command:
        pass
    else:
        stage = ("mkdir" if "mkdir " in command else "token" if "cat > " in command else
                 "chmod" if "chmod " in command else "ready" if "if [ -f " in command else "cleanup")
        fail(stage)
        if stage == "ready" and failure == "bad-ready":
            print("{}")
            sys.exit(0)
        sys.exit(subprocess.call(["/bin/sh", "-c", mapped(command)]))
elif args[0] == "forward":
    registry = Path(config["registry"])
    with Path(str(registry) + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        rows = json.loads(registry.read_text()) if registry.exists() else []
        if args[1] == "--list":
            if failure == "cleanup-timeout":
                time.sleep(60)
            for row in rows:
                print(" ".join(row))
        elif args[1] == "--remove":
            rows = [row for row in rows if not (row[0] == config["serial"] and row[1] == args[2])]
            registry.write_text(json.dumps(rows))
        else:
            assert args[1:3] == ["--no-rebind", "tcp:0"], args
            remote = args[3]
            rows.append([config["serial"], remote, remote])
            registry.write_text(json.dumps(rows))
            fail("forward")  # allocation happened, but the reply was lost
            print("invalid-port" if failure == "bad-forward" else remote.split(":")[1])
elif args == ["huge"]:
    sys.stdout.write("x" * (1024 * 1024))
elif args == ["held-pipe"]:
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(2)"], stdin=subprocess.DEVNULL)
else:
    raise AssertionError(args)
