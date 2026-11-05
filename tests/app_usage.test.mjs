import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const scanView = url(transpile(await readFile(new URL("../src/scanView.ts", import.meta.url), "utf8")));
const source = transpile(await readFile(new URL("../src/appUsageSummary.ts", import.meta.url), "utf8")).replace('"./scanView"', JSON.stringify(scanView));
const { parseAppUsage } = await import(url(source));
const scope = { generation: "scan", revision: 2, total_size: 15, errors: 1, skipped: 0 };
const report = () => ({
  ...scope, attributed_size: 10, unattributed_size: 5, total_packages: 2,
  skip: 0, next_skip: null,
  packages: [
    { package_id: "com.denied", scanned_size: 0, locations: 1 },
    { package_id: "com.example", scanned_size: 10, locations: 2 },
  ],
});
const parse = data => parseAppUsage(JSON.stringify(data), scope, 0);

test("package bytes reconcile while zero scanned bytes and coverage remain explicit", () => {
  assert.deepEqual(parse(report()), report());
});

test("stale, inconsistent, malformed and unordered package pages are rejected", () => {
  for (const data of [
    null, { ...report(), generation: "old" }, { ...report(), revision: 3 },
    { ...report(), errors: 0 }, { ...report(), attributed_size: 11 },
    { ...report(), packages: null }, { ...report(), next_skip: 2 },
    { ...report(), packages: report().packages.reverse() },
    { ...report(), packages: Array(2).fill(report().packages[0]) },
    { ...report(), packages: [{ package_id: "fake-folder", scanned_size: 0, locations: 0 }, report().packages[1]] },
  ]) assert.throws(() => parse(data));
});

test("continuation and page limits cover all entries exactly", () => {
  const expected = { ...scope, total_size: 101 };
  const all = Array.from({ length: 101 }, (_, id) => ({
    package_id: `com.app${String(id).padStart(3, "0")}`, scanned_size: 1, locations: 1,
  }));
  const page = { ...expected, attributed_size: 101, unattributed_size: 0, total_packages: 101,
    skip: 0, next_skip: 100, packages: all.slice(0, 100) };
  assert.equal(parseAppUsage(JSON.stringify(page), expected, 0).packages.length, 100);
  const last = { ...page, skip: 100, next_skip: null, packages: all.slice(100) };
  assert.equal(parseAppUsage(JSON.stringify(last), expected, 100).packages[0].package_id, "com.app100");
  assert.throws(() => parseAppUsage(JSON.stringify({ ...page, packages: all }), expected, 0));
  assert.throws(() => parseAppUsage(JSON.stringify(last), expected, 0));
});

test("an empty scan has no attributed bytes or invented package rows", () => {
  const expected = { ...scope, total_size: 0 };
  const empty = { ...expected, attributed_size: 0, unattributed_size: 0, total_packages: 0,
    skip: 0, next_skip: null, packages: [] };
  assert.deepEqual(parseAppUsage(JSON.stringify(empty), expected, 0), empty);
});
