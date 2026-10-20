import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Exercise the installed CLI and real config, including its nonzero exit gate.
// Stdin fixtures never create production files or launch the app.
function lint(source) {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../node_modules/eslint/bin/eslint.js", import.meta.url)),
    "--stdin", "--stdin-filename", "src/lint-gate-fixture.tsx",
    "--format", "json", "--max-warnings", "0",
  ], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    input: source, encoding: "utf8", timeout: 15000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 2, result.stderr);
  const [report] = JSON.parse(result.stdout);
  return { status: result.status, messages: report.messages };
}

test("lint accepts a typed JSX component with complete effect dependencies", () => {
  const result = lint(`
    import { useEffect } from "react";
    export function Example({ value }: { value: number }) {
      useEffect(() => { console.log(value); }, [value]);
      return <span>{value}</span>;
    }
  `);
  assert.equal(result.status, 0);
  assert.deepEqual(result.messages, []);
});

for (const [name, rule, source] of [
  ["explicit any", "@typescript-eslint/no-explicit-any", "export const value: any = 1;"],
  ["conditional hook", "react-hooks/rules-of-hooks", `
    import { useState } from "react";
    export function Example({ ready }: { ready: boolean }) {
      if (ready) useState(0);
      return null;
    }
  `],
  ["missing effect dependency", "react-hooks/exhaustive-deps", `
    import { useEffect } from "react";
    export function Example({ value }: { value: number }) {
      useEffect(() => { console.log(value); }, []);
      return null;
    }
  `],
]) {
  test(`lint rejects ${name} with a nonzero exit`, () => {
    const result = lint(source);
    assert.equal(result.status, 1);
    assert.ok(result.messages.some(message => message.ruleId === rule), JSON.stringify(result.messages));
  });
}

test("zero-warning lint gate also rejects an unused disable directive", () => {
  const result = lint("// eslint-disable-next-line no-alert\nexport const value = 1;\n");
  assert.equal(result.status, 1);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].severity, 1);
  assert.match(result.messages[0].message, /Unused eslint-disable/);
});
