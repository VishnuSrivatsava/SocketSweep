"""Build-script fixtures use disposable resources and fake NDK compilers."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform in ("darwin", "linux") and shutil.which("bash"),
                     "The existing Bash build entry point supports macOS/Linux")
class EngineBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="socketsweep build fixture ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.engine = self.root / "repository with spaces/engine"
        self.engine.mkdir(parents=True)
        scripts = Path(__file__).resolve().parents[1] / "engine"
        for name in ("build.sh", "build_daemon.py"):
            shutil.copyfile(scripts / name, self.engine / name)
        # Fail closed if a broken discovery path ever selects a real compiler.
        (self.engine / "daemon.cpp").write_text('#error "Use the fake compiler fixture"\n')
        self.bundled = self.engine.parent / "src-tauri/bin/daemon"
        self.bundled.parent.mkdir(parents=True)
        self.bundled.write_bytes(b"existing bundle")
        (self.engine / "daemon").write_bytes(b"existing engine")
        self.environment = {key: value for key, value in os.environ.items()
                            if key not in ("NDK", "ANDROID_NDK_LATEST_HOME", "ANDROID_NDK_HOME",
                                           "FAKE_COMPILER_FAIL", "FAKE_COMPILER_NO_OUTPUT")}
        self.ndks = {label: self.fake_ndk(label) for label in ("explicit", "latest", "home")}

    def fake_ndk(self, label):
        ndk = self.root / f"NDK {label} with spaces"
        host = "darwin-x86_64" if sys.platform == "darwin" else "linux-x86_64"
        compiler = ndk / f"toolchains/llvm/prebuilt/{host}/bin/aarch64-linux-android31-clang++"
        compiler.parent.mkdir(parents=True)
        compiler.write_text("#!/usr/bin/env python3\n"
                            "import json, os, sys\nfrom pathlib import Path\n"
                            f"Path({str(ndk / 'calls.json')!r}).write_text(json.dumps(sys.argv[1:]))\n"
                            "if os.environ.get('FAKE_COMPILER_NO_OUTPUT'): sys.exit(0)\n"
                            f"Path(sys.argv[sys.argv.index('-o') + 1]).write_bytes({label.encode()!r})\n"
                            "if os.environ.get('FAKE_COMPILER_FAIL'): sys.exit(1)\n"
                            "Path(sys.argv[sys.argv.index('-o') + 1]).chmod(0o755)\n")
        compiler.chmod(0o700)
        return ndk

    def build(self, *args, default_abis=False, **variables):
        return subprocess.run(["bash", str(self.engine / "build.sh"),
                               *([] if args or default_abis else ["--abi", "arm64-v8a"]), *args], cwd=self.root,
                              env={**self.environment, **{key: str(value) for key, value in variables.items()}},
                              capture_output=True, text=True, timeout=15)

    def assert_selected(self, label, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.engine / "daemon").read_bytes(), label.encode())
        self.assertEqual(self.bundled.read_bytes(), label.encode())
        args = json.loads((self.ndks[label] / "calls.json").read_text())
        staged = Path(args[args.index("-o") + 1])
        self.assertEqual(staged.name, "daemon")
        self.assertEqual(staged.parent.parent, self.bundled.parent)
        self.assertFalse(staged.parent.exists(), "Staging directory leaked after success")
        self.assertTrue(os.access(self.engine / "daemon", os.X_OK))
        self.assertEqual(args, ["-std=c++17", "-O2", "-pthread", "-Wall", "-Wextra", "-Wpedantic",
                                "-fno-exceptions", "-fno-rtti", "-DNDEBUG", "-static-libstdc++", "-s",
                                "-o", str(staged), str(self.engine / "daemon.cpp")])
        for other in self.ndks:
            if other != label:
                self.assertFalse((self.ndks[other] / "calls.json").exists())

    def test_explicit_ndk_remains_highest_priority(self):
        self.assert_selected("explicit", self.build(NDK=self.ndks["explicit"],
                             ANDROID_NDK_LATEST_HOME=self.ndks["latest"], ANDROID_NDK_HOME=self.ndks["home"]))

    def test_latest_home_is_used_before_home_when_ndk_is_unset_or_empty(self):
        for explicit in ({}, {"NDK": ""}):
            with self.subTest(explicit=explicit):
                self.assert_selected("latest", self.build(**explicit,
                                     ANDROID_NDK_LATEST_HOME=self.ndks["latest"], ANDROID_NDK_HOME=self.ndks["home"]))

    def test_home_is_used_when_latest_is_unset_or_empty(self):
        for latest in ({}, {"ANDROID_NDK_LATEST_HOME": ""}):
            with self.subTest(latest=latest):
                self.assert_selected("home", self.build(**latest, ANDROID_NDK_HOME=self.ndks["home"]))

    def test_invalid_selected_path_does_not_fall_back_or_replace_resources(self):
        missing = self.root / "missing NDK"
        for variables in [
            {"NDK": missing, "ANDROID_NDK_LATEST_HOME": self.ndks["latest"], "ANDROID_NDK_HOME": self.ndks["home"]},
            {"ANDROID_NDK_LATEST_HOME": missing, "ANDROID_NDK_HOME": self.ndks["home"]},
            {"ANDROID_NDK_HOME": missing},
        ]:
            with self.subTest(variables=variables):
                result = self.build(**variables)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(str(missing), result.stdout + result.stderr)
                self.assertEqual(self.bundled.read_bytes(), b"existing bundle")
                self.assertEqual((self.engine / "daemon").read_bytes(), b"existing engine")
                self.assertFalse(any((ndk / "calls.json").exists() for ndk in self.ndks.values()))

    def test_failed_compiler_preserves_both_existing_artifacts(self):
        result = self.build(NDK=self.ndks["explicit"], FAKE_COMPILER_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.engine / "daemon").read_bytes(), b"existing engine")
        self.assertEqual(self.bundled.read_bytes(), b"existing bundle")
        self.assertEqual(list(self.engine.glob(".daemon-build-*")) + list(self.bundled.parent.glob(".daemon-build-*")), [])

    def test_compiler_success_without_output_cannot_publish_a_stale_binary(self):
        result = self.build(NDK=self.ndks["explicit"], FAKE_COMPILER_NO_OUTPUT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.engine / "daemon").read_bytes(), b"existing engine")
        self.assertEqual(self.bundled.read_bytes(), b"existing bundle")
        self.assertEqual(list(self.engine.glob(".daemon-build-*")) + list(self.bundled.parent.glob(".daemon-build-*")), [])

    def test_output_directory_is_rejected_without_mutation(self):
        output = self.engine / "daemon"
        output.unlink()
        output.mkdir()
        sentinel = output / "keep"
        sentinel.write_bytes(b"keep")
        result = self.build(NDK=self.ndks["explicit"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Output path is not a regular file", result.stderr)
        self.assertEqual(sentinel.read_bytes(), b"keep")
        self.assertEqual(list(output.iterdir()), [sentinel])
        self.assertEqual(self.bundled.read_bytes(), b"existing bundle")
        self.assertFalse((self.ndks["explicit"] / "calls.json").exists())


    def test_32_bit_build_keeps_existing_arm64_artifacts(self):
        ndk = self.ndks["explicit"]
        compiler = next(ndk.rglob("aarch64-linux-android31-clang++"))
        compiler.rename(compiler.with_name("armv7a-linux-androideabi31-clang++"))
        result = self.build("--abi", "armeabi-v7a", NDK=ndk)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.engine / "daemon-armeabi-v7a").read_bytes(), b"explicit")
        self.assertEqual((self.engine / "daemon").read_bytes(), b"existing engine")
        self.assertEqual(self.bundled.read_bytes(), b"existing bundle")
        self.assertIn("-D_FILE_OFFSET_BITS=64", json.loads((ndk / "calls.json").read_text()))
        self.assertEqual((self.bundled.parent / "daemon-armeabi-v7a").read_bytes(), b"explicit")

    def test_default_build_provisions_all_four_abis(self):
        ndk = self.ndks["explicit"]
        compiler = next(ndk.rglob("aarch64-linux-android31-clang++"))
        for target in ("armv7a-linux-androideabi", "i686-linux-android", "x86_64-linux-android"):
            shutil.copyfile(compiler, compiler.with_name(f"{target}31-clang++"))
            compiler.with_name(f"{target}31-clang++").chmod(0o700)
        result = self.build(default_abis=True, NDK=ndk)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for name in ("daemon", "daemon-armeabi-v7a", "daemon-x86", "daemon-x86_64"):
            self.assertEqual((self.engine / name).read_bytes(), b"explicit")
            self.assertEqual((self.bundled.parent / name).read_bytes(), b"explicit")
