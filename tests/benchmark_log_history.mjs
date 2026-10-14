// Host-only append/retention measurement, not native UI or daemon performance.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const count = 20000;
if (process.argv[2] !== "--worker") {
  const samples = {};
  for (const mode of ["legacy", "bounded"]) {
    samples[mode] = [];
    for (let run = 0; run < 3; run++) {
      const child = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker", mode], { encoding: "utf8" });
      if (child.status !== 0) throw Error(child.stderr);
      samples[mode].push(JSON.parse(child.stdout));
    }
  }
  const median = values => values.sort((a, b) => a - b)[1];
  console.log(JSON.stringify({ count, node: process.version, platform: process.platform, results:
    Object.fromEntries(Object.entries(samples).map(([mode, runs]) => [mode,
      Object.fromEntries(Object.keys(runs[0]).map(key => [key, median(runs.map(run => run[key]))]))])) }, null, 2));
} else {
  const source = await readFile(new URL("../src/logHistory.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  });
  const { appendLog, emptyLogHistory } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
  let history = emptyLogHistory();
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const message = `[12:34:56] [SCAN] /sdcard/${i}/` + "synthetic-path-".repeat(8) + "文件😀";
    history = process.argv[3] === "legacy" ? { entries: [...history.entries, message] } : appendLog(history, message);
  }
  const append_ms = performance.now() - start;
  global.gc();
  const retained_heap_delta = process.memoryUsage().heapUsed - before;
  console.log(JSON.stringify({ append_ms, retained_heap_delta, entries: history.entries.length,
    retained_text_bytes: history.entries.reduce((sum, entry) => sum + entry.length * 2, 0) }));
}
