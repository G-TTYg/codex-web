import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const { BrowserHost } = require("../src/server/browser-host.js");

async function eventually(read, predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function pageHtml(title) {
  return `<!doctype html>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { min-height: 1600px; margin: 0; background: #0b57d0; color: white; }
      button { position: absolute; left: 20px; top: 20px; width: 120px; height: 48px; }
      input { position: absolute; left: 20px; top: 90px; width: 180px; height: 32px; }
    </style>
    <button id="tap" onclick="document.body.dataset.tapped = 'yes'">tap</button>
    <input id="text">
    <script>setInterval(() => document.body.dataset.tick = Date.now(), 100)</script>`;
}

function createSession(host, sessionId, width, height) {
  const frames = [];
  const events = [];
  let createdState = null;
  let closedError;
  host.createSession(
    {
      height,
      ipcInvokeChannels: [],
      partition: `persist:codex-web-browser-test-${process.pid}-${sessionId}`,
      sessionId,
      width,
    },
    {
      onBeforeRequest: async () => ({ cancel: false }),
      onClosed: (errorMessage) => {
        closedError = errorMessage ?? "closed";
      },
      onCreated: (state) => {
        createdState = state;
      },
      onEvent: (message) => events.push(message),
      onFrame: (frame) => frames.push(frame),
      onIpcInvoke: async () => undefined,
      onIpcMessage: () => undefined,
    },
  );
  return {
    get closedError() {
      return closedError;
    },
    get createdState() {
      return createdState;
    },
    events,
    frames,
  };
}

async function assertNoWindowsMainHandle(processId) {
  if (process.platform !== "win32") {
    return;
  }
  const probe = `$source = @'
using System;
using System.Runtime.InteropServices;
public static class CodexWebWindowProbe {
  private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  public static int CountVisible(uint targetProcessId) {
    var count = 0;
    EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
      uint ownerProcessId;
      GetWindowThreadProcessId(handle, out ownerProcessId);
      if (ownerProcessId == targetProcessId && IsWindowVisible(handle)) count += 1;
      return true;
    }, IntPtr.Zero);
    return count;
  }
}
'@
Add-Type -TypeDefinition $source
$process = Get-Process -Id ${processId} -ErrorAction Stop
'{0},{1}' -f $process.MainWindowHandle, [CodexWebWindowProbe]::CountVisible(${processId})`;
  for (let sample = 0; sample < 3; sample += 1) {
    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      probe,
    ]);
    assert.equal(stdout.trim(), "0,0");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

test(
  "Electron Browser host paints shared guests without a visible BrowserWindow",
  { timeout: 35_000 },
  async (context) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml("Browser host smoke"));
    });
    const port = await listen(server);
    const host = new BrowserHost(projectRoot);
    context.after(async () => {
      await host.dispose();
      await new Promise((resolve) => server.close(resolve));
    });

    const first = createSession(host, "first", 640, 360);
    await eventually(
      () => first.createdState,
      Boolean,
      "first Browser guest was not created",
    );
    const helperProcessId = host.child?.pid;
    assert.ok(helperProcessId, "Electron helper process is missing");
    await assertNoWindowsMainHandle(helperProcessId);

    await host.command("first", "loadURL", [`http://127.0.0.1:${port}/first`]);
    const firstFrame = await eventually(
      () => first.frames.find((frame) => frame.data.length > 100),
      Boolean,
      "first Browser guest did not paint",
    );
    assert.equal(firstFrame.width, 640);
    assert.equal(firstFrame.height, 360);
    assert.equal(first.closedError, undefined);

    await host.command("first", "sendInputEvent", [
      { type: "touchStart", touch: { x: 60, y: 44 } },
    ]);
    await host.command("first", "sendInputEvent", [
      { type: "touchEnd", touch: { x: 60, y: 44 } },
    ]);
    await eventually(
      async () =>
        await host.command("first", "executeJavaScript", [
          "document.body.dataset.tapped",
        ]),
      (value) => value === "yes",
      "CDP touch tap did not activate the page",
    );

    await host.command("first", "executeJavaScript", [
      "document.querySelector('#text').focus()",
    ]);
    await host.command("first", "insertText", ["native input"]);
    assert.equal(
      await host.command("first", "executeJavaScript", [
        "document.querySelector('#text').value",
      ]),
      "native input",
    );

    await host.command("first", "sendInputEvent", [
      { type: "touchStart", touch: { x: 300, y: 300 } },
    ]);
    await host.command("first", "sendInputEvent", [
      { type: "touchMove", touch: { x: 300, y: 80 } },
    ]);
    await host.command("first", "sendInputEvent", [
      { type: "touchEnd", touch: { x: 300, y: 80 } },
    ]);
    await eventually(
      async () => await host.command("first", "executeJavaScript", ["scrollY"]),
      (value) => Number(value) > 0,
      "CDP touch drag did not scroll the page",
    );

    await host.command("first", "resize", [800, 500]);
    const resizedFrame = await eventually(
      () =>
        first.frames.find(
          (frame) => frame.width === 800 && frame.height === 500,
        ),
      Boolean,
      "resized Browser guest did not paint at its new logical size",
    );
    assert.ok(resizedFrame.data.length > 100);

    const second = createSession(host, "second", 320, 200);
    await eventually(
      () => second.createdState,
      Boolean,
      "second Browser guest was not created",
    );
    await host.command("second", "loadURL", [
      `http://127.0.0.1:${port}/second`,
    ]);
    const secondFrame = await eventually(
      () => second.frames.find((frame) => frame.data.length > 100),
      Boolean,
      "second Browser guest did not paint",
    );
    assert.equal(secondFrame.width, 320);
    assert.equal(secondFrame.height, 200);
    assert.equal(
      await host.command("first", "executeJavaScript", ["document.title"]),
      "Browser host smoke",
    );
    const firstFrameCount = first.frames.length;
    await host.command("first", "executeJavaScript", [
      "document.body.style.background = '#d93025'",
    ]);
    await eventually(
      () => first.frames.length,
      (count) => count > firstFrameCount,
      "the first guest stopped painting while the second guest was attached",
    );
    await assertNoWindowsMainHandle(helperProcessId);

    const capture = await host.command("second", "capturePage", []);
    assert.ok(Buffer.isBuffer(capture.data));
    assert.ok(capture.data.length > 100);
    assert.ok(capture.size.width > 0);
    assert.ok(capture.size.height > 0);

    await host.command("second", "close", []);
    await eventually(
      () => second.closedError,
      (value) => value === "closed",
      "guest close did not propagate through the host lifecycle",
    );
    host.destroySession("first");
  },
);
