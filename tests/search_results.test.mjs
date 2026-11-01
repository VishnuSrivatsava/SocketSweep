import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const scanView = url(transpile(await readFile(new URL("../src/scanView.ts", import.meta.url), "utf8")));
const source = transpile(await readFile(new URL("../src/searchResults.ts", import.meta.url), "utf8")).replace('"./scanView"', JSON.stringify(scanView));
const { parseSearchResults, MAX_SEARCH_RESULTS } = await import(url(source));
const expected = { generation: "scan-a", revision: 2, root_path: "/fixture", read_only: false, total_size: 10 };
const row = (id, name, size, type = "file", counted = true) => ({ path: `/fixture/${name}`, node: {
  id, parent_id: 0, name, type, size, counted, child_count: type === "directory" ? 1 : 0, can_delete: true,
} });
const report = () => ({ generation: "scan-a", revision: 2, query: "log", skip: 0, has_more: false,
  results: [row(3, "app.log", 7), row(5, "Logs", 3, "directory", true)] });
const parse = (data, scope = expected, query = "log", skip = 0) => parseSearchResults(JSON.stringify(data), scope, query, skip);

test("valid pages keep exact labels, IDs and both entry kinds", () => {
  assert.deepEqual(parse(report()).results, report().results);
  assert.equal(parse(report()).has_more, false);
  const page = report();
  page.skip = 100;
  assert.equal(parse(page, expected, "log", 100).skip, 100);
  page.results[0].ignored = "not part of the contract";
  assert.equal(parse(page, expected, "log", 100).results[0].ignored, undefined);
});

test("empty results and byte-bounded short pages with a continuation are accepted", () => {
  const empty = { ...report(), results: [] };
  assert.equal(parse(empty).results.length, 0);
  const full = { ...report(), has_more: true, results: Array(MAX_SEARCH_RESULTS).fill(row(2, "app.log", 7)) };
  full.results = full.results.map((entry, index) => row(index + 2, `app-${index}.log`, 1));
  assert.equal(parse(full).has_more, true);
  assert.equal(parse({ ...report(), has_more: true }).has_more, true);
});

test("malformed payloads, pages, queries and continuations are rejected", () => {
  for (const raw of ["{", "null", "[]", "5"]) assert.throws(() => parseSearchResults(raw, expected, "log", 0));
  for (const results of [null, {}, [null], [null, report().results[1]], [{ node: null, path: "/fixture/app.log" }, report().results[1]]]) {
    assert.throws(() => parse({ ...report(), results }));
  }
  assert.throws(() => parse({ ...report(), results: Array(MAX_SEARCH_RESULTS + 1).fill(report().results[0]) }));
  for (const changes of [{ generation: "old" }, { revision: 1 }, { revision: -1 }, { query: "LOG" }, { skip: 1 }, { has_more: "no" }]) {
    assert.throws(() => parse({ ...report(), ...changes }));
  }
  // A continuation must make progress; skip must echo the request.
  assert.throws(() => parse({ ...report(), results: [], has_more: true }));
  assert.throws(() => parse(report(), expected, "log", 3));
  assert.throws(() => parse(report(), expected, "log", -1));
  assert.throws(() => parse(report(), expected, "", 0));
  assert.throws(() => parseSearchResults(JSON.stringify(report()), expected, undefined, 0));
});

test("duplicate or root node IDs and duplicate paths are rejected", () => {
  const duplicate = report(); duplicate.results[1] = { ...duplicate.results[1], node: { ...duplicate.results[1].node, id: 3 } };
  assert.throws(() => parse(duplicate));
  const root = report(); root.results[0] = { path: "/fixture", node: { id: 0, parent_id: null, name: "fixture", type: "directory", size: 10, counted: true, child_count: 2, can_delete: false } };
  assert.throws(() => parse(root));
  const path = report(); path.results[1] = { ...path.results[1], path: "/fixture/app.log" };
  assert.throws(() => parse(path));
});

test("paths must match the scan root, exact name and parent shape", () => {
  for (const path of ["/another/app.log", "/fixture/../app.log", "/fixture//app.log", "/fixture/wrong.log", "/fixture/nested/app.log"]) {
    const data = report(); data.results[0].path = path; assert.throws(() => parse(data));
  }
  for (const name of ["", ".", "..", "a/b", "bad\0name", "x".repeat(256), "\ud800"]) {
    const data = report(); data.results[0] = row(2, name, 7); assert.throws(() => parse(data));
  }
  const nested = report(); nested.results[0].path = "/fixture/nested/app.log"; nested.results[0].node.parent_id = 1;
  assert.equal(parse(nested).results[0].node.parent_id, 1);
  const atRoot = report(); atRoot.results.forEach(entry => { entry.path = `/${entry.node.name}`; });
  assert.equal(parse(atRoot, { ...expected, root_path: "/" }).results.length, 2);
});

test("directory rows, uncounted entries and Unicode labels stay exact and safe", () => {
  const uncounted = report(); uncounted.results[0] = row(4, "placeholder", 0, "file", false);
  assert.equal(parse(uncounted).results[0].node.counted, false);
  for (const name of [" leading trailing ", "\ufeffname", "photo-🙂", "报告.log"]) {
    const data = report(); data.results[0] = row(2, name, 7);
    assert.equal(parse(data).results[0].node.name, name);
  }
  for (const delimiter of ["line\nname", "line\rname"]) {
    const data = report(); data.results[0] = row(2, delimiter, 7); data.results[0].node.can_delete = false;
    assert.equal(parse(data).results[0].node.can_delete, false);
    const deletable = report(); deletable.results[0] = row(2, delimiter, 7);
    assert.throws(() => parse(deletable));
  }
});
