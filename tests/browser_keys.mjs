// Trusted keyboard input for the isolated headless-browser fixture, never Tauri.
import { readFile } from "node:fs/promises";

const keys = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  "Shift+Tab": { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
};
const key = keys[process.argv[3]];
if (!key) throw Error("Unsupported fixture key");
const port = (await readFile(process.argv[2], "utf8")).split("\n")[0];
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(item => item.type === "page");
if (!page) throw Error("Fixture browser page missing");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const send = params => new Promise((resolve, reject) => {
  const id = ++sequence;
  const receive = event => {
    const result = JSON.parse(event.data);
    if (result.id !== id) return;
    socket.removeEventListener("message", receive);
    if (result.error) reject(Error(result.error.message)); else resolve();
  };
  socket.addEventListener("message", receive);
  socket.send(JSON.stringify({ id, method: "Input.dispatchKeyEvent", params }));
});
try {
  await send({ type: "keyDown", ...key });
  const release = { ...key };
  delete release.text;
  await send({ type: "keyUp", ...release });
} finally {
  socket.close();
}
