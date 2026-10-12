import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// CI uses Node 20: compile the production TypeScript with the existing compiler.
const source = await readFile(new URL("../src/formatBytes.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const { formatBytes } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const cases = [
  ["zero", 0, "0 B"],
  ["negative zero", -0, "0 B"],
  ["one byte", 1, "1 B"],
  ["last byte before KB", 1023, "1023 B"],
  ["KB boundary", 1024, "1.0 KB"],
  ["KB precision", 1536, "1.5 KB"],
  ["last byte before MB", 1024 ** 2 - 1, "1024.0 KB"],
  ["MB boundary", 1024 ** 2, "1.0 MB"],
  ["last byte before GB", 1024 ** 3 - 1, "1024.0 MB"],
  ["GB boundary", 1024 ** 3, "1.0 GB"],
  ["last byte before TB", 1024 ** 4 - 1, "1024.0 GB"],
  ["TB boundary", 1024 ** 4, "1.0 TB"],
  ["fraction below one byte", 0.5, "0.5 B"],
  ["fraction above one byte", 1.5, "1.5 B"],
  ["small fraction", 0.005, "5.0e-3 B"],
  ["smallest positive number", Number.MIN_VALUE, "4.9e-324 B"],
  ["negative bytes", -1, "-1 B"],
  ["negative scaled value", -1536, "-1.5 KB"],
  ["negative fraction", -0.5, "-0.5 B"],
  ["negative small fraction", -0.005, "-5.0e-3 B"],
  ["beyond unit range", 1024 ** 5, "1024.0 TB"],
  ["largest exact integer", Number.MAX_SAFE_INTEGER, "8192.0 TB"],
  ["huge finite value", Number.MAX_VALUE, "1.6e+296 TB"],
  ["huge negative value", -Number.MAX_VALUE, "-1.6e+296 TB"],
  ["NaN", NaN, "Unknown"],
  ["positive infinity", Infinity, "Unknown"],
  ["negative infinity", -Infinity, "Unknown"],
];

for (const [label, bytes, expected] of cases) {
  test(label, () => assert.equal(formatBytes(bytes), expected));
}

test("finite values retain their sign and produce bounded, valid labels", () => {
  for (let exponent = -1074; exponent <= 1023; exponent++) {
    const magnitude = 2 ** exponent;
    for (const bytes of [magnitude, -magnitude]) {
      const result = formatBytes(bytes);
      assert.match(result, /^-?\d+(?:\.\d+)?(?:e[+-]\d+)? (?:B|KB|MB|GB|TB)$/);
      assert.equal(result.startsWith("-"), bytes < 0);
      assert.ok(result.length <= 32, result);
      assert.ok(Number(result.split(" ")[0]) !== 0, result);
    }
  }
});
