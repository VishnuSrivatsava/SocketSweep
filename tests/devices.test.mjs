import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/devices.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const { preserveDeviceSelection, deviceSelectionHint, deviceStateLabel, deviceDiscoveryMessage } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const phone = (serial, state = "device") => ({ serial, state, model: null });

test("initial selection requires exactly one ready device", () => {
  assert.equal(preserveDeviceSelection("", []), "");
  assert.equal(preserveDeviceSelection("", [phone("locked", "unauthorized")]), "");
  assert.equal(preserveDeviceSelection("", [phone("one"), phone("locked", "unauthorized")]), "one");
  assert.equal(preserveDeviceSelection("", [phone("one"), phone("two")]), "");
});

test("refresh and unplugging never replace an existing selection", () => {
  for (const devices of [[], [phone("other")], [phone("other"), phone("chosen", "offline")], [phone("chosen"), phone("other")]]) {
    assert.equal(preserveDeviceSelection("chosen", devices), "chosen");
  }
  const wireless = "[2001:db8::1]:5555";
  assert.equal(preserveDeviceSelection("", [phone(wireless)]), wireless);
});

test("unavailable selections explain the required action without claiming readiness", () => {
  assert.match(deviceSelectionHint([], "chosen"), /disconnected/);
  assert.match(deviceSelectionHint([phone("chosen", "offline")], "chosen"), /offline/);
  assert.match(deviceSelectionHint([phone("chosen", "unauthorized")], "chosen"), /approve USB debugging/);
  assert.match(deviceSelectionHint([phone("chosen", "no permissions")], "chosen"), /permissions/);
  assert.match(deviceSelectionHint([phone("chosen", "recovery")], "chosen"), /not ready/);
  assert.match(deviceSelectionHint([], ""), /No devices/);
  assert.match(deviceSelectionHint([phone("one"), phone("two")], ""), /Choose/);
  assert.equal(deviceStateLabel("device"), "Ready");
  assert.equal(deviceStateLabel("recovery"), "recovery");
});

test("discovery failures show actionable summaries without raw diagnostics", () => {
  for (const detail of ["ADB server didn't ACK", "* failed to start daemon", "could not install *smartsocket* listener: Address already in use", "cannot connect to daemon"]) {
    const message = deviceDiscoveryMessage("adb devices -l failed (exit 1): " + detail + "\n" + "x".repeat(10000));
    assert.match(message, /ADB could not start/);
    assert.match(message, /refresh/);
    assert.ok(message.length < 120);
    assert.ok(!message.includes(detail));
  }
  assert.match(deviceDiscoveryMessage("ADB command timed out"), /timed out.*refresh/);
  const raw = "<img src=x onerror=alert(1)> /private/log " + "x".repeat(100000);
  assert.equal(deviceDiscoveryMessage(raw), "Couldn't check connected devices. Refresh to try again.");
});
