import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourcePath = new URL(
  "../src/browser/browser-webview.ts",
  import.meta.url,
);
const electronShimSourcePath = new URL(
  "../src/server/electron/index.ts",
  import.meta.url,
);
let moduleSequence = 0;

class FakeEventTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    this.emit(event.type, event);
    return true;
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeStyle {
  cssText = "";
  left = "";
  top = "";
}

class FakeElement extends FakeEventTarget {
  #attributes = new Map();
  active = false;
  children = [];
  draggable = false;
  inputMode = "";
  isConnected = false;
  spellcheck = false;
  style = new FakeStyle();
  tabIndex = -1;
  value = "";

  get attributes() {
    return [...this.#attributes].map(([name, value]) => ({ name, value }));
  }

  append(...children) {
    this.children.push(...children);
  }

  attachShadow() {
    throw new Error("webview cannot host a shadow root in an ordinary browser");
  }

  blur() {
    this.active = false;
    if (globalThis.document?.activeElement === this) {
      globalThis.document.activeElement = null;
    }
  }

  focus() {
    this.active = true;
    globalThis.document.activeElement = this;
  }

  getBoundingClientRect() {
    return { height: 600, left: 10, top: 20, width: 800 };
  }

  hasAttribute(name) {
    return this.#attributes.has(name);
  }

  setAttribute(name, value) {
    this.#attributes.set(name, String(value));
  }

  setPointerCapture() {}
}

class FakeDocument {
  activeElement = null;
  documentElement = new FakeElement();

  createElement() {
    return new FakeElement();
  }

  querySelectorAll() {
    return [];
  }
}

async function loadBrowserWebviewModule() {
  const source = await readFile(sourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "browser-webview.ts",
  });
  moduleSequence += 1;
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${moduleSequence}`);
}

async function loadElectronShimModule() {
  const source = await readFile(electronShimSourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "electron/index.ts",
  });
  moduleSequence += 1;
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${moduleSequence}`);
}

function installFakeDom() {
  delete globalThis[Symbol.for("codex-web.browser-webview-runtime")];
  FakeDocument.prototype.createElement = function createElement() {
    return new FakeElement();
  };
  const document = new FakeDocument();
  const windowTarget = new FakeEventTarget();
  windowTarget.setTimeout = globalThis.setTimeout;
  windowTarget.clearTimeout = globalThis.clearTimeout;
  const mutationObservers = [];
  globalThis.Document = FakeDocument;
  globalThis.HTMLElement = FakeElement;
  globalThis.document = document;
  globalThis.window = windowTarget;
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      mutationObservers.push(this);
    }

    observe() {}
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  return {
    document,
    emitWindow(type, event) {
      windowTarget.emit(type, event);
    },
    flushMutations() {
      for (const observer of mutationObservers) {
        observer.callback();
      }
    },
  };
}

test("remote webview uses the native slot and touch-only input transport", async () => {
  const fakeDom = installFakeDom();
  const messages = [];
  const browserWebview = await loadBrowserWebviewModule();
  browserWebview.installBrowserWebviews((message) => messages.push(message));

  const element = fakeDom.document.createElement("webview");
  element.setAttribute("partition", "persist:test");
  element.setAttribute("data-browser-sidebar-conversation-id", "conversation");
  element.isConnected = true;
  fakeDom.flushMutations();

  const create = messages.find(
    (message) => message.type === "browser-webview-create",
  );
  assert.ok(create);
  assert.equal(create.width, 800);
  assert.equal(create.height, 600);
  assert.equal(create.params.partition, "persist:test");
  assert.equal(
    create.params["data-browser-sidebar-conversation-id"],
    "conversation",
  );

  browserWebview.handleBrowserWebviewMessage({
    type: "browser-webview-frame",
    viewId: create.viewId,
    data: "frame",
    editableRects: [
      { x: 50, y: 60, width: 200, height: 40, inputMode: "search" },
    ],
    width: 800,
    height: 600,
  });

  const image = element.children[0];
  const keyboard = element.children[1];
  image.emit("pointerdown", {
    altKey: false,
    button: 0,
    clientX: 70,
    clientY: 100,
    ctrlKey: false,
    metaKey: false,
    offsetX: 60,
    offsetY: 80,
    pointerId: 7,
    pointerType: "touch",
    preventDefault() {},
    shiftKey: false,
  });
  image.emit("pointermove", {
    clientX: 70,
    clientY: 200,
    pointerId: 7,
    pointerType: "touch",
    preventDefault() {},
  });
  image.emit("pointerup", {
    altKey: false,
    button: 0,
    clientX: 70,
    clientY: 200,
    ctrlKey: false,
    metaKey: false,
    pointerId: 7,
    preventDefault() {},
    shiftKey: false,
  });

  const inputTypes = messages
    .filter(
      (message) =>
        message.type === "browser-webview-command" &&
        message.method === "sendInputEvent",
    )
    .map((message) => message.args[0].type);
  assert.deepEqual(inputTypes, ["touchStart", "touchMove", "touchEnd"]);
  assert.equal(keyboard.active, true);
  assert.equal(keyboard.inputMode, "search");
  assert.equal(image.src, "data:image/jpeg;base64,frame");
  assert.equal(element.shadow, undefined);

  let prevented = 0;
  let stopped = 0;
  let stoppedImmediately = 0;
  const keyboardEvent = {
    altKey: false,
    code: "KeyX",
    ctrlKey: false,
    isComposing: false,
    key: "x",
    metaKey: false,
    preventDefault() {
      prevented += 1;
    },
    shiftKey: false,
    stopPropagation() {
      stopped += 1;
    },
    stopImmediatePropagation() {
      stoppedImmediately += 1;
    },
    target: element,
  };
  element.focus();
  fakeDom.emitWindow("keydown", keyboardEvent);
  fakeDom.emitWindow("keyup", keyboardEvent);
  assert.deepEqual(
    messages
      .filter(
        (message) =>
          message.type === "browser-webview-command" &&
          message.method === "sendInputEvent",
      )
      .slice(-3)
      .map((message) => message.args[0].type),
    ["keyDown", "char", "keyUp"],
  );
  assert.equal(prevented, 2);
  assert.equal(stopped, 2);
  assert.equal(stoppedImmediately, 2);
});

test("webview installation is idempotent across duplicate preload evaluation", async () => {
  const fakeDom = installFakeDom();
  const firstMessages = [];
  const secondMessages = [];
  const firstModule = await loadBrowserWebviewModule();
  const secondModule = await loadBrowserWebviewModule();

  firstModule.installBrowserWebviews((message) => firstMessages.push(message));
  secondModule.installBrowserWebviews((message) =>
    secondMessages.push(message),
  );

  const element = fakeDom.document.createElement("webview");
  element.isConnected = true;
  fakeDom.flushMutations();

  assert.equal(firstMessages.length, 0);
  assert.equal(
    secondMessages.filter(
      (message) => message.type === "browser-webview-create",
    ).length,
    1,
  );
  assert.equal(element.children.length, 2);
});

test("Browser host remains a runtime dependency and preserves native attach lifecycle", async () => {
  const [packageJson, browserHost, electronShim, serverMain] =
    await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8").then(
        JSON.parse,
      ),
      readFile(
        new URL("../src/server/browser-host-electron.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../src/server/electron/index.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../src/server/main.ts", import.meta.url), "utf8"),
    ]);

  assert.equal(packageJson.dependencies.electron, "42.3.0");
  assert.equal(packageJson.devDependencies?.electron, undefined);
  assert.match(electronShim, /"will-attach-webview"/);
  assert.match(electronShim, /"did-attach-webview"/);
  assert.match(electronShim, /new RemoteWebContents\(/);
  assert.match(browserHost, /let hostWindow: BaseWindow \| null = null/);
  assert.match(browserHost, /new BaseWindow\(/);
  assert.match(browserHost, /new WebContentsView\(/);
  assert.equal(browserHost.match(/new BaseWindow\(/g)?.length, 1);
  assert.match(browserHost, /window\.contentView\.addChildView\(view\)/);
  assert.doesNotMatch(browserHost, /new BrowserWindow\(/);
  assert.match(browserHost, /focusable:\s*false/);
  assert.match(browserHost, /frame:\s*false/);
  assert.match(browserHost, /hasShadow:\s*false/);
  assert.match(browserHost, /opacity:\s*0/);
  assert.match(browserHost, /show:\s*false/);
  assert.match(browserHost, /skipTaskbar:\s*true/);
  assert.match(browserHost, /offscreen:\s*\{ useSharedTexture: false \}/);
  assert.match(browserHost, /window\.on\("show"/);
  assert.match(browserHost, /window\.on\("focus"/);
  assert.match(browserHost, /window\.setOpacity\(0\)/);
  assert.match(browserHost, /window\.setPosition\(/);
  assert.match(browserHost, /window\.setFocusable\(false\)/);
  assert.doesNotMatch(
    browserHost,
    /case "focus":[\s\S]*?webContents\.focus\(\)/,
  );
  assert.doesNotMatch(
    browserHost,
    /case "inspectElement":\s*webContents\.inspectElement/,
  );
  assert.match(serverMain, /new BrowserHost\(projectRoot\)/);
  assert.match(serverMain, /browserConnectionId/);
  assert.doesNotMatch(serverMain, /iframe/i);
});

test("Electron shim attaches a remote guest and forwards native page state", async (t) => {
  t.mock.method(console, "log", () => {});
  const sessions = new Map();
  const commands = [];
  const notifications = [];
  globalThis.__CODEX_SHIM_VALUES__ = { version: "test" };
  delete globalThis.__codexElectronIpcBridge;
  globalThis.__codexBrowserHostBridge = {
    command: async (sessionId, method, args = []) => {
      commands.push({ sessionId, method, args });
      return undefined;
    },
    createSession(options, callbacks) {
      sessions.set(options.sessionId, { options, callbacks });
    },
    destroySession(sessionId) {
      sessions.delete(sessionId);
    },
    notify(sessionId, method, args = []) {
      notifications.push({ sessionId, method, args });
    },
  };

  const electron = await loadElectronShimModule();
  const ownerWindow = new electron.BrowserWindow();
  const backgroundWindow = new electron.BrowserWindow();
  ownerWindow.focus();
  backgroundWindow.showInactive();
  assert.equal(electron.BrowserWindow.getFocusedWindow(), ownerWindow);
  const browserSession = electron.session.fromPartition("persist:browser");
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.url === "https://blocked.test/" });
  });
  electron.ipcMain.handle("guest:test", (event, value) => ({
    senderId: event.sender.id,
    value,
  }));
  let didAttachGuest = null;
  ownerWindow.webContents.on(
    "will-attach-webview",
    (_event, webPreferences, params) => {
      webPreferences.preload = "comment-preload.js";
      webPreferences.session = browserSession;
      params.partition = "persist:browser";
    },
  );
  ownerWindow.webContents.on("did-attach-webview", (_event, guest) => {
    didAttachGuest = guest;
  });

  const rendererMessages = [];
  globalThis.__codexElectronIpcBridge.handleRendererWebviewCreate(
    {
      type: "browser-webview-create",
      viewId: "view-1",
      instanceId: 9,
      params: { partition: "persist:route", src: "about:blank" },
      width: 900,
      height: 700,
    },
    (message) => rendererMessages.push(message),
  );

  assert.ok(didAttachGuest);
  assert.equal(didAttachGuest.viewInstanceId, 9);
  assert.deepEqual(sessions.get("view-1").options, {
    sessionId: "view-1",
    partition: "persist:browser",
    preloadPath: "comment-preload.js",
    additionalArguments: undefined,
    ipcInvokeChannels: ["guest:test"],
    width: 900,
    height: 700,
  });
  assert.equal(rendererMessages[0].type, "browser-webview-attached");

  let navigatedUrl = null;
  didAttachGuest.on("did-navigate", (_event, url) => {
    navigatedUrl = url;
  });
  sessions.get("view-1").callbacks.onEvent({
    type: "event",
    sessionId: "view-1",
    name: "did-navigate",
    args: ["https://example.test/"],
    state: {
      canGoBack: false,
      canGoForward: false,
      historyIndex: 0,
      isLoading: false,
      isLoadingMainFrame: false,
      title: "Example",
      url: "https://example.test/",
      zoomFactor: 1,
    },
  });
  assert.equal(navigatedUrl, "https://example.test/");
  assert.equal(didAttachGuest.getURL(), "https://example.test/");
  assert.equal(didAttachGuest.getTitle(), "Example");

  const notificationCountBeforeFocus = notifications.length;
  didAttachGuest.focus();
  assert.equal(electron.webContents.getFocusedWebContents(), didAttachGuest);
  assert.equal(notifications.length, notificationCountBeforeFocus + 1);
  assert.equal(notifications.at(-1).method, "focus");

  assert.deepEqual(
    await sessions
      .get("view-1")
      .callbacks.onBeforeRequest({ url: "https://blocked.test/" }),
    { cancel: true },
  );
  assert.deepEqual(
    await sessions
      .get("view-1")
      .callbacks.onIpcInvoke("guest:test", ["payload"]),
    { senderId: didAttachGuest.id, value: "payload" },
  );

  await didAttachGuest.loadURL("https://next.test/");
  assert.equal(commands.at(-1).method, "loadURL");
  globalThis.__codexElectronIpcBridge.handleRendererWebviewCommand(
    "view-1",
    "sendInputEvent",
    [{ type: "touchStart", touch: { x: 1, y: 2 } }],
  );
  assert.equal(notifications.at(-1).method, "sendInputEvent");
});
