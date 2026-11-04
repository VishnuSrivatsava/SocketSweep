import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/storageMapLayout.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const { layoutStorageMap } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("each tile, including Other, covers its share of the full byte total", () => {
  const chart = Array.from({ length: 64 }, (_, id) => ({ node_id: id + 1, name: ` file ${id} `, size: 100 - id }));
  chart.push({ node_id: null, name: "Other", size: 5000 });
  const total = chart.reduce((sum, tile) => sum + tile.size, 0);
  for (const [width, height] of [[1600, 100], [200, 700]]) {
    const layout = layoutStorageMap(chart, total, width, height);
    assert.equal(layout.length, chart.length);
    for (const [index, tile] of layout.entries()) {
      assert.equal(tile.name, chart[index].name);
      assert.equal(tile.node_id, chart[index].node_id);
      assert.ok(Math.abs(tile.width * tile.height / (width * height) - tile.size / total) < 1e-12);
      assert.ok(tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= width + 1e-9 && tile.y + tile.height <= height + 1e-9);
    }
  }
});

test("empty, zero-byte and incomplete charts do not fill the storage map", () => {
  assert.deepEqual(layoutStorageMap([], 0, 100, 100), []);
  assert.deepEqual(layoutStorageMap([{ node_id: 1, name: "empty", size: 0 }], 0, 100, 100), []);
  assert.deepEqual(layoutStorageMap([{ node_id: 1, name: "partial", size: 1 }], 2, 100, 100), []);
});
