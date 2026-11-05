"""Check ELF architecture validation independently of an installed NDK."""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import check_daemon_symbols as symbols


class SymbolArchitectureTests(unittest.TestCase):
    def verify(self, abi, elf_class, machine):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "daemon"
            debug = root / "symbols"
            binary.write_bytes(b"stripped")
            debug.write_bytes(b"debug")

            def run(command, **_kwargs):
                tool = Path(command[0]).stem
                if tool == "llvm-nm":
                    return "00001000 T main\n"
                if tool == "llvm-symbolizer":
                    return "main\n/source/daemon.cpp:123:1\n"
                option = command[1]
                if option == "--file-header":
                    return f"  Class: {elf_class}\n  Machine: {machine}\n"
                if option == "--notes":
                    return "Build ID: abcdef\n"
                if option == "--sections":
                    return ".debug_info .debug_line .symtab" if command[-1] == str(debug) else ".text"
                if option == "--hex-dump=.text":
                    return "same code bytes"
                raise AssertionError(command)

            with patch("check_daemon_symbols.subprocess.check_output", side_effect=run), contextlib.redirect_stdout(io.StringIO()):
                return symbols.check(root, binary, debug, "a" * 40, "linux", abi)

    def test_all_abis_record_the_requested_target(self):
        for abi, (elf_class, machine, target) in symbols.TARGETS.items():
            with self.subTest(abi=abi):
                self.assertEqual(self.verify(abi, elf_class, machine)["target"], target)

    def test_wrong_machine_or_word_size_is_rejected(self):
        for elf_class, machine in [
            ("ELF32", "AArch64"),
            ("ELF64", "ARM"),
            ("ELF64", "AArch64 extra"),
        ]:
            with self.subTest(elf_class=elf_class, machine=machine):
                with self.assertRaisesRegex(ValueError, "Expected Android arm64-v8a ELF"):
                    self.verify("arm64-v8a", elf_class, machine)
