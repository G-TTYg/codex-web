import path from "node:path";

import {
  app,
  BaseWindow,
  ipcMain,
  session,
  type KeyboardInputEvent,
  type MouseInputEvent,
  type MouseWheelInputEvent,
  type WebContents,
  WebContentsView,
} from "electron";

import {
  type BrowserEditableRect,
  type BrowserHostCreateOptions,
  type BrowserHostState,
  type BrowserHostToServerMessage,
  type ServerToBrowserHostMessage,
} from "./browser-host-protocol";

type HostedPage = {
  editableRects: BrowserEditableRect[];
  editableRefreshPending: boolean;
  height: number;
  lastFrameAt: number;
  suppressClosedMessage: boolean;
  view: WebContentsView;
  width: number;
};

type PendingHostRequest = {
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
};

const FRAME_INTERVAL_MS = 66;
const EDITABLE_REFRESH_INTERVAL_MS = 250;
const OFFSCREEN_WINDOW_ORIGIN = -32_000;
const MIN_PAGE_HEIGHT = 160;
const MIN_PAGE_WIDTH = 240;
const pages = new Map<string, HostedPage>();
const pageSessionIdsByWebContentsId = new Map<number, string>();
const configuredPartitions = new Set<string>();
const installedInvokeChannels = new Set<string>();
const pendingHostRequests = new Map<string, PendingHostRequest>();
let shuttingDown = false;
let hostRequestSequence = 0;
let hostWindow: BaseWindow | null = null;

function send(message: BrowserHostToServerMessage): void {
  process.send?.(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestHost(
  message:
    | {
        details: Record<string, unknown>;
        sessionId: string;
        type: "before-request";
      }
    | {
        args: unknown[];
        channel: string;
        sessionId: string;
        type: "ipc-invoke";
      },
): Promise<unknown> {
  const requestId = `browser_guest_${++hostRequestSequence}`;
  return new Promise((resolve, reject) => {
    pendingHostRequests.set(requestId, { resolve, reject });
    send({ ...message, requestId });
  });
}

function ensureInvokeChannel(channel: string): void {
  if (installedInvokeChannels.has(channel)) {
    return;
  }
  installedInvokeChannels.add(channel);
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    const sessionId = pageSessionIdsByWebContentsId.get(event.sender.id);
    if (!sessionId) {
      throw new Error(
        `Browser guest IPC sender is unavailable for ${channel}.`,
      );
    }
    return await requestHost({ type: "ipc-invoke", sessionId, channel, args });
  });
}

function configureSession(partition: string): Electron.Session {
  const browserSession = session.fromPartition(partition);
  if (configuredPartitions.has(partition)) {
    return browserSession;
  }
  configuredPartitions.add(partition);

  // The Desktop Browser session permits only Chromium's sanitized clipboard
  // write permission. All other permission requests remain fail-closed.
  browserSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "clipboard-sanitized-write");
    },
  );
  browserSession.setPermissionCheckHandler(
    (_webContents, permission) => permission === "clipboard-sanitized-write",
  );
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const sessionId = pageSessionIdsByWebContentsId.get(
      details.webContentsId ?? -1,
    );
    if (!sessionId) {
      callback({ cancel: true });
      return;
    }
    void requestHost({
      type: "before-request",
      sessionId,
      details: sanitize(details) as Record<string, unknown>,
    })
      .then((result) => {
        const cancel =
          typeof result === "object" &&
          result !== null &&
          Reflect.get(result, "cancel") === true;
        callback({ cancel });
      })
      .catch(() => callback({ cancel: true }));
  });
  return browserSession;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (depth >= 8) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, depth + 1));
  }
  if (value instanceof Error) {
    return { message: value.message, name: value.name, stack: value.stack };
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== "function") {
        output[key] = sanitize(entry, depth + 1);
      }
    }
    return output;
  }
  return null;
}

function stateFor(webContents: WebContents): BrowserHostState {
  if (webContents.isDestroyed()) {
    return {
      canGoBack: false,
      canGoForward: false,
      historyIndex: -1,
      isLoading: false,
      isLoadingMainFrame: false,
      title: "",
      url: "",
      zoomFactor: 1,
    };
  }
  return {
    canGoBack: webContents.navigationHistory.canGoBack(),
    canGoForward: webContents.navigationHistory.canGoForward(),
    historyIndex: webContents.navigationHistory.getActiveIndex(),
    isLoading: webContents.isLoading(),
    isLoadingMainFrame: webContents.isLoadingMainFrame(),
    title: webContents.getTitle(),
    url: webContents.getURL(),
    zoomFactor: webContents.getZoomFactor(),
  };
}

function eventData(
  event: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (typeof event !== "object" || event === null) {
    return data;
  }
  for (const key of keys) {
    const value = Reflect.get(event, key);
    if (typeof value !== "function" && value !== undefined) {
      data[key] =
        key === "initiator" && typeof value === "object" && value !== null
          ? { url: Reflect.get(value, "url") }
          : sanitize(value);
    }
  }
  return data;
}

function emitEvent(
  sessionId: string,
  name: string,
  event: unknown,
  args: unknown[] = [],
  eventKeys: readonly string[] = [],
): void {
  const page = pages.get(sessionId);
  if (!page || page.view.webContents.isDestroyed()) {
    return;
  }
  send({
    type: "event",
    sessionId,
    name,
    eventData: eventData(event, eventKeys),
    args: sanitize(args) as unknown[],
    state: stateFor(page.view.webContents),
  });
}

function installEventForwarding(
  sessionId: string,
  webContents: WebContents,
): void {
  webContents.on("page-title-updated", (event, title, explicitSet) => {
    emitEvent(sessionId, "page-title-updated", event, [title, explicitSet]);
  });
  webContents.on("page-favicon-updated", (event, favicons) => {
    emitEvent(sessionId, "page-favicon-updated", event, [favicons]);
  });
  webContents.on("audio-state-changed", (event) => {
    emitEvent(sessionId, "audio-state-changed", event, [], ["audible"]);
  });
  webContents.on("did-start-loading", () => {
    emitEvent(sessionId, "did-start-loading", {});
  });
  webContents.on(
    "did-start-navigation",
    (event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) => {
      emitEvent(sessionId, "did-start-navigation", event, [
        url,
        isInPlace,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
      ]);
    },
  );
  webContents.on("did-stop-loading", () => {
    emitEvent(sessionId, "did-stop-loading", {});
  });
  webContents.on("did-finish-load", () => {
    emitEvent(sessionId, "did-finish-load", {});
  });
  webContents.on(
    "did-navigate",
    (event, url, httpResponseCode, httpStatusText) => {
      emitEvent(sessionId, "did-navigate", event, [
        url,
        httpResponseCode,
        httpStatusText,
      ]);
    },
  );
  webContents.on(
    "did-navigate-in-page",
    (event, url, isMainFrame, frameProcessId, frameRoutingId) => {
      emitEvent(sessionId, "did-navigate-in-page", event, [
        url,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
      ]);
    },
  );
  webContents.on("did-redirect-navigation", (event) => {
    emitEvent(
      sessionId,
      "did-redirect-navigation",
      event,
      [],
      ["url", "isSameDocument", "isMainFrame"],
    );
  });
  webContents.on(
    "did-fail-load",
    (
      event,
      code,
      description,
      validatedUrl,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    ) => {
      emitEvent(sessionId, "did-fail-load", event, [
        code,
        description,
        validatedUrl,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
      ]);
    },
  );
  webContents.on("will-frame-navigate", (event) => {
    emitEvent(
      sessionId,
      "will-frame-navigate",
      event,
      [],
      ["url", "isSameDocument", "isMainFrame", "initiator"],
    );
  });
  webContents.on("will-navigate", (event, url) => {
    emitEvent(sessionId, "will-navigate", event, [url], ["url", "initiator"]);
  });
  webContents.on("will-redirect", (event, url, isInPlace, isMainFrame) => {
    emitEvent(
      sessionId,
      "will-redirect",
      event,
      [url, isInPlace, isMainFrame],
      ["url", "isMainFrame", "initiator"],
    );
  });
  webContents.on("dom-ready", () => {
    emitEvent(sessionId, "dom-ready", {});
    scheduleEditableRefresh(sessionId, true);
  });
  webContents.on("render-process-gone", (event, details) => {
    emitEvent(sessionId, "render-process-gone", event, [details]);
  });
  webContents.on("unresponsive", () => {
    emitEvent(sessionId, "unresponsive", {});
  });
  webContents.on("found-in-page", (event, result) => {
    emitEvent(sessionId, "found-in-page", event, [result]);
  });
  webContents.on("before-input-event", (event, input) => {
    emitEvent(sessionId, "before-input-event", event, [input]);
  });
  webContents.on("context-menu", (event, params) => {
    emitEvent(sessionId, "context-menu", event, [params]);
  });
  webContents.on("ipc-message", (_event, channel, ...args) => {
    send({
      type: "ipc-message",
      sessionId,
      channel,
      args: sanitize(args) as unknown[],
    });
  });
  webContents.setWindowOpenHandler((details) => {
    emitEvent(
      sessionId,
      "window-open",
      details,
      [],
      ["url", "frameName", "features", "disposition", "referrer", "postBody"],
    );
    return { action: "deny" };
  });
}

function installFrameForwarding(sessionId: string, page: HostedPage): void {
  const webContents = page.view.webContents;
  webContents.setFrameRate(15);
  webContents.on("paint", (_event, _dirtyRect, image) => {
    const now = Date.now();
    if (now - page.lastFrameAt < FRAME_INTERVAL_MS || image.isEmpty()) {
      return;
    }
    page.lastFrameAt = now;
    send({
      type: "frame",
      sessionId,
      data: image.toJPEG(72),
      editableRects: page.editableRects,
      width: page.width,
      height: page.height,
    });
    scheduleEditableRefresh(sessionId);
  });
}

function scheduleEditableRefresh(sessionId: string, immediate = false): void {
  const page = pages.get(sessionId);
  if (!page || page.editableRefreshPending) {
    return;
  }
  page.editableRefreshPending = true;
  const run = (): void => {
    const current = pages.get(sessionId);
    if (!current || current.view.webContents.isDestroyed()) {
      return;
    }
    void current.view.webContents
      .executeJavaScript(
        `(() => Array.from(document.querySelectorAll(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), [contenteditable=""], [contenteditable="true"]'
      )).flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return [];
        return [{
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          inputMode: element.inputMode || (element.type === 'number' ? 'decimal' : 'text'),
        }];
      }))()`,
        false,
      )
      .then((rects: unknown) => {
        if (pages.get(sessionId) === current && Array.isArray(rects)) {
          current.editableRects = rects.filter(isEditableRect);
          current.view.webContents.invalidate();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (pages.get(sessionId) === current) {
          current.editableRefreshPending = false;
        }
      });
  };
  if (immediate) {
    run();
  } else {
    setTimeout(run, EDITABLE_REFRESH_INTERVAL_MS).unref();
  }
}

function isEditableRect(value: unknown): value is BrowserEditableRect {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return ["x", "y", "width", "height"].every(
    (key) => typeof Reflect.get(value, key) === "number",
  );
}

function concealOffscreenHost(window: BaseWindow): void {
  // Electron 42 gives a completely detached WebContentsView a 0x0 compositor.
  // One shared BaseWindow supplies only native bounds; it must never become a
  // Browser tab window or any other visible part of the product.
  if (window.isDestroyed()) {
    return;
  }
  window.setFocusable(false);
  if (window.getOpacity() !== 0) {
    window.setOpacity(0);
  }
  window.setSkipTaskbar(true);
  window.setPosition(OFFSCREEN_WINDOW_ORIGIN, OFFSCREEN_WINDOW_ORIGIN, false);
  if (window.isVisible()) {
    window.hide();
  }
}

function enforceOffscreenHost(window: BaseWindow): void {
  concealOffscreenHost(window);
  window.on("show", () => concealOffscreenHost(window));
  window.on("focus", () => {
    if (!window.isDestroyed()) {
      window.blur();
      concealOffscreenHost(window);
    }
  });
}

function closePagesAfterHostLoss(window: BaseWindow): void {
  if (hostWindow !== window) {
    return;
  }
  hostWindow = null;
  for (const [sessionId, page] of [...pages]) {
    pages.delete(sessionId);
    const webContents = page.view.webContents;
    pageSessionIdsByWebContentsId.delete(webContents.id);
    if (!webContents.isDestroyed()) {
      webContents.close({ waitForBeforeUnload: false });
    }
    if (!page.suppressClosedMessage && !shuttingDown) {
      send({
        type: "closed",
        sessionId,
        errorMessage: "The shared Browser rendering host closed.",
      });
    }
  }
}

function ensureHostWindow(width: number, height: number): BaseWindow {
  if (hostWindow && !hostWindow.isDestroyed()) {
    return hostWindow;
  }
  const window = new BaseWindow({
    focusable: false,
    frame: false,
    hasShadow: false,
    opacity: 0,
    show: false,
    skipTaskbar: true,
    useContentSize: true,
    width,
    height,
    x: OFFSCREEN_WINDOW_ORIGIN,
    y: OFFSCREEN_WINDOW_ORIGIN,
  });
  hostWindow = window;
  enforceOffscreenHost(window);
  window.once("closed", () => closePagesAfterHostLoss(window));
  return window;
}

function resizeHostWindow(): void {
  const window = hostWindow;
  if (!window || window.isDestroyed()) {
    return;
  }
  let width = MIN_PAGE_WIDTH;
  let height = MIN_PAGE_HEIGHT;
  for (const page of pages.values()) {
    width = Math.max(width, page.width);
    height = Math.max(height, page.height);
  }
  window.setContentSize(width, height, false);
  concealOffscreenHost(window);
}

function createPage(options: BrowserHostCreateOptions): void {
  destroyPage(options.sessionId, true);
  const partition = options.partition || "persist:codex-web-browser";
  const browserSession = configureSession(partition);
  for (const channel of options.ipcInvokeChannels) {
    ensureInvokeChannel(channel);
  }
  const width = Math.max(MIN_PAGE_WIDTH, Math.round(options.width));
  const height = Math.max(MIN_PAGE_HEIGHT, Math.round(options.height));
  const window = ensureHostWindow(width, height);
  const view = new WebContentsView({
    webPreferences: {
      additionalArguments: options.additionalArguments,
      backgroundThrottling: false,
      contextIsolation: true,
      devTools: false,
      nodeIntegration: false,
      offscreen: { useSharedTexture: false },
      preload: options.preloadPath,
      sandbox: true,
      session: browserSession,
      webSecurity: true,
      webviewTag: false,
    },
  });
  view.setBounds({ x: 0, y: 0, width, height });
  const page: HostedPage = {
    editableRects: [],
    editableRefreshPending: false,
    height,
    lastFrameAt: 0,
    suppressClosedMessage: false,
    view,
    width,
  };
  pages.set(options.sessionId, page);
  window.contentView.addChildView(view);
  resizeHostWindow();
  const webContents = view.webContents;
  pageSessionIdsByWebContentsId.set(webContents.id, options.sessionId);
  installEventForwarding(options.sessionId, webContents);
  installFrameForwarding(options.sessionId, page);
  webContents.on("devtools-opened", () => webContents.closeDevTools());
  webContents.once("destroyed", () => {
    pageSessionIdsByWebContentsId.delete(webContents.id);
    if (pages.get(options.sessionId) !== page) {
      return;
    }
    pages.delete(options.sessionId);
    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.contentView.removeChildView(view);
      resizeHostWindow();
    }
    if (!page.suppressClosedMessage) {
      send({ type: "closed", sessionId: options.sessionId });
    }
  });
  send({
    type: "created",
    sessionId: options.sessionId,
    state: stateFor(webContents),
  });
}

function destroyPage(sessionId: string, suppressClosedMessage = false): void {
  const page = pages.get(sessionId);
  if (!page) {
    return;
  }
  pages.delete(sessionId);
  page.suppressClosedMessage = suppressClosedMessage;
  const webContents = page.view.webContents;
  if (!webContents.isDestroyed()) {
    pageSessionIdsByWebContentsId.delete(webContents.id);
  }
  if (hostWindow && !hostWindow.isDestroyed()) {
    hostWindow.contentView.removeChildView(page.view);
  }
  if (!webContents.isDestroyed()) {
    webContents.close({ waitForBeforeUnload: false });
  }
  resizeHostWindow();
  if (!suppressClosedMessage) {
    send({ type: "closed", sessionId });
  }
}

async function runCommand(
  sessionId: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const page = pages.get(sessionId);
  if (!page || page.view.webContents.isDestroyed()) {
    throw new Error(`Browser page is not available: ${sessionId}`);
  }
  const webContents = page.view.webContents;
  switch (method) {
    case "loadURL":
      return await webContents.loadURL(String(args[0]), args[1] as never);
    case "reload":
      webContents.reload();
      return undefined;
    case "reloadIgnoringCache":
      webContents.reloadIgnoringCache();
      return undefined;
    case "stop":
      webContents.stop();
      return undefined;
    case "goBack":
      webContents.goBack();
      return undefined;
    case "goForward":
      webContents.goForward();
      return undefined;
    case "executeJavaScript":
      return sanitize(
        await webContents.executeJavaScript(String(args[0]), args[1] === true),
      );
    case "capturePage": {
      const image = await webContents.capturePage(args[0] as never);
      return {
        data: image.toPNG(),
        size: image.getSize(),
      };
    }
    case "sendInputEvent":
      if (
        typeof args[0] === "object" &&
        args[0] !== null &&
        typeof Reflect.get(args[0], "type") === "string" &&
        String(Reflect.get(args[0], "type")).startsWith("touch")
      ) {
        const input = args[0] as {
          type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel";
          touch?: { x?: number; y?: number };
        };
        if (!webContents.debugger.isAttached()) {
          webContents.debugger.attach("1.3");
        }
        await webContents.debugger.sendCommand("Input.dispatchTouchEvent", {
          type: input.type,
          touchPoints:
            input.type === "touchEnd" || input.type === "touchCancel"
              ? []
              : [
                  {
                    x: Number(input.touch?.x) || 0,
                    y: Number(input.touch?.y) || 0,
                  },
                ],
        });
      } else {
        webContents.sendInputEvent(
          args[0] as
            | KeyboardInputEvent
            | MouseInputEvent
            | MouseWheelInputEvent,
        );
      }
      return undefined;
    case "insertText":
      webContents.insertText(String(args[0] ?? ""));
      return undefined;
    case "send":
      webContents.send(String(args[0]), ...args.slice(1));
      return undefined;
    case "focus":
      // RemoteWebContents tracks logical focus in the plain-Node shim. Input
      // injection targets the guest directly and must not activate its hidden
      // native owner: focusing it can let Windows reveal an Electron surface.
      return undefined;
    case "resize":
      page.width = Math.max(
        MIN_PAGE_WIDTH,
        Math.round(Number(args[0]) || MIN_PAGE_WIDTH),
      );
      page.height = Math.max(
        MIN_PAGE_HEIGHT,
        Math.round(Number(args[1]) || MIN_PAGE_HEIGHT),
      );
      page.view.setBounds({
        x: 0,
        y: 0,
        width: page.width,
        height: page.height,
      });
      resizeHostWindow();
      webContents.invalidate();
      return undefined;
    case "setZoomFactor":
      webContents.setZoomFactor(Number(args[0]) || 1);
      return undefined;
    case "setBackgroundThrottling":
      webContents.setBackgroundThrottling(args[0] !== false);
      return undefined;
    case "findInPage":
      return webContents.findInPage(String(args[0]), args[1] as never);
    case "stopFindInPage":
      webContents.stopFindInPage(args[0] as never);
      return undefined;
    case "downloadURL":
      webContents.downloadURL(String(args[0]), args[1] as never);
      return undefined;
    case "inspectElement":
      // Native DevTools would be another host OS window. The web surface owns
      // inspection and must never reveal this rendering sidecar.
      return undefined;
    case "debugger.attach":
      webContents.debugger.attach(args[0] as string | undefined);
      return undefined;
    case "debugger.detach":
      webContents.debugger.detach();
      return undefined;
    case "debugger.sendCommand":
      return sanitize(
        await webContents.debugger.sendCommand(
          String(args[0]),
          args[1] as Record<string, unknown> | undefined,
          args[2] as string | undefined,
        ),
      );
    case "close":
      destroyPage(sessionId);
      return undefined;
    default:
      throw new Error(`Unsupported Browser host command: ${method}`);
  }
}

async function handleMessage(
  message: ServerToBrowserHostMessage,
): Promise<void> {
  if (message.type === "host-request-result") {
    const pending = pendingHostRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingHostRequests.delete(message.requestId);
    if (message.errorMessage) {
      pending.reject(new Error(message.errorMessage));
    } else {
      pending.resolve(message.result);
    }
    return;
  }
  if (message.type === "create") {
    createPage(message);
    return;
  }
  if (message.type === "destroy") {
    destroyPage(message.sessionId, true);
    return;
  }
  if (message.type === "shutdown") {
    shuttingDown = true;
    for (const sessionId of [...pages.keys()]) {
      destroyPage(sessionId, true);
    }
    app.quit();
    return;
  }
  if (message.type !== "command") {
    return;
  }

  try {
    const result = await runCommand(
      message.sessionId,
      message.method,
      message.args,
    );
    if (message.requestId) {
      send({
        type: "command-result",
        sessionId: message.sessionId,
        requestId: message.requestId,
        result,
      });
    }
  } catch (error) {
    if (message.requestId) {
      send({
        type: "command-error",
        sessionId: message.sessionId,
        requestId: message.requestId,
        errorMessage: errorMessage(error),
      });
    } else {
      send({
        type: "event",
        sessionId: message.sessionId,
        name: "host-command-error",
        args: [message.method, errorMessage(error)],
        state: pages.has(message.sessionId)
          ? stateFor(pages.get(message.sessionId)!.view.webContents)
          : {
              canGoBack: false,
              canGoForward: false,
              historyIndex: -1,
              isLoading: false,
              isLoadingMainFrame: false,
              title: "",
              url: "",
              zoomFactor: 1,
            },
      });
    }
  }
}

const projectRoot = process.env.CODEX_WEB_PROJECT_ROOT;
if (projectRoot) {
  app.setPath("userData", path.join(projectRoot, "scratch", "browser-host"));
}
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.on("window-all-closed", () => undefined);
process.on("message", (message: ServerToBrowserHostMessage) => {
  void handleMessage(message);
});
process.on("disconnect", () => {
  shuttingDown = true;
  for (const pending of pendingHostRequests.values()) {
    pending.reject(new Error("The Browser host IPC connection closed."));
  }
  pendingHostRequests.clear();
  app.quit();
});

void app.whenReady().then(() => {
  send({ type: "ready", electronVersion: process.versions.electron });
});
