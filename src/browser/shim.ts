import {
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";
import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";
import {
  hasTouchInputCapability,
  installMobileLayout,
  shouldUseMobileLayout,
} from "./mobile-layout";
import { installMobileInteractions } from "./mobile-interactions";
import { installMobileKeyboardViewport } from "./mobile-keyboard";
import { installClipboardCompatibility } from "./clipboard";
import {
  createRendererContextMenuCoordinator,
  type SetRendererContextMenuOpen,
} from "./context-menu";
import {
  handleBrowserWebviewMessage,
  installBrowserWebviews,
  markBrowserWebviewsDisconnected,
  reconnectBrowserWebviews,
  type BrowserWebviewMainMessage,
  type BrowserWebviewRendererMessage,
} from "./browser-webview";
import { openUrlInEmbeddedBrowser } from "./embedded-browser-navigation";
import {
  createBuildRevisionGuard,
  type ServerBuildRevisionMessage,
} from "./build-revision";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    }
  | BrowserWebviewRendererMessage;

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | ServerBuildRevisionMessage
  | BrowserWebviewMainMessage;

const RECONNECT_DELAY_MS = 1_000;

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type StatsigGateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

type ElectronShimState = {
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  closeRightPanel?: () => void;
  openContextMenuFromButton?: (button: HTMLElement) => void;
  setRendererContextMenuOpen?: SetRendererContextMenuOpen;
  shouldAutoFocusComposer?: () => boolean;
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  overrideAdapter?: {
    getGateOverride?: (
      evaluation: StatsigGateEvaluation,
      ...args: unknown[]
    ) => StatsigGateEvaluation | null;
  };
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
  }
}

declare const __CODEX_APP_VERSION__: string;
declare const __CODEX_ELECTRON_VERSION__: string;
declare const __CODEX_WEB_BUILD_REVISION__: string;

let requestCounter = 0;
let socket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
const outboundQueue: RendererToMainMessage[] = [];
const pendingInvokes = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();
const pendingDirectoryEntries = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
  }
>();
const rendererListeners = new Map<string, Set<IpcListener>>();
const messagePorts = new Map<string, MessagePort>();
const handleBuildRevisionMessage = createBuildRevisionGuard(
  __CODEX_WEB_BUILD_REVISION__,
  () => window.location.reload(),
);

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    listener(event, ...args);
  }
}

function handleIncomingMessage(message: MainToRendererMessage): void {
  if (handleBuildRevisionMessage(message)) {
    return;
  }
  if (handleBrowserWebviewMessage(message)) {
    return;
  }
  if (message.type === "ipc-main-event") {
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
    return;
  }

  if (message.type === "message-port-message") {
    messagePorts.get(message.portId)?.postMessage(message.data);
    return;
  }

  if (message.type === "message-port-close") {
    const port = messagePorts.get(message.portId);
    messagePorts.delete(message.portId);
    port?.close();
    return;
  }

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingDirectoryEntries.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

function flushOutboundQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  for (const message of outboundQueue.splice(0)) {
    socket.send(JSON.stringify(message));
  }
}

function scheduleReconnect(): void {
  if (reconnectTimeoutId !== null) {
    return;
  }
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    ensureSocket();
  }, RECONNECT_DELAY_MS);
}

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  socket = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc`,
  );
  socket.addEventListener("open", () => {
    flushOutboundQueue();
    reconnectBrowserWebviews();
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as MainToRendererMessage;
      handleIncomingMessage(message);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  socket.addEventListener("close", () => {
    markBrowserWebviewsDisconnected();
    for (const port of messagePorts.values()) {
      port.close();
    }
    messagePorts.clear();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    scheduleReconnect();
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
  outboundQueue.push(message);
  ensureSocket();
  flushOutboundQueue();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingInvokes.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/skills" ||
    path === "/automations"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
): Promise<WorkspaceDirectoryEntries> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingDirectoryEntries.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly: true,
    });
  });
}

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const initialSidebarState = !shouldUseMobileLayout();
const electronShim = (window.__ELECTRON_SHIM__ ??= {});
const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

installClipboardCompatibility();
installBrowserWebviews(enqueueMessage);
// Mount-time composer focus is useful with a hardware keyboard, but on touch
// devices it must not create a software keyboard without a direct tap. Keep the
// editor DOM/inputmode stable and gate only the renderer's mount-focus action.
electronShim.shouldAutoFocusComposer = () => !hasTouchInputCapability();
electronShim.setRendererContextMenuOpen =
  createRendererContextMenuCoordinator();
// Install the viewport focus listener before mobile search intentionally stops
// blur propagation. The keyboard coordinator still observes the settled focus
// target without allowing renderer-owned search surfaces to unmount.
installMobileKeyboardViewport();
installMobileLayout(
  () => electronShim.closeSidebar?.(),
  () => electronShim.closeRightPanel?.(),
);
installMobileInteractions();

if (typeof globalThis.crypto.randomUUID !== "function") {
  // randomUUID is secure-context-only, but direct HTTP Tailnet addresses are
  // intentionally supported. getRandomValues remains available and provides
  // the same cryptographic entropy for an RFC 4122 UUID v4.
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    writable: false,
  });
}

Object.assign(globalThis, {
  process: {
    arch: "arm64",
    platform: "darwin",
    versions: {
      electron: __CODEX_ELECTRON_VERSION__,
    },
  },
});

electronShim.overrideAdapter = {
  getGateOverride(evaluation) {
    if (evaluation.name === "2911712394") {
      return {
        ...evaluation,
        value: true,
      };
    }

    if (evaluation.name === "1042620455") {
      // Remote control (Slingshot).
      return {
        ...evaluation,
        value: true,
      };
    }

    return null;
  },
};

const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = initialRoute.memoryPath;

if (initialRoute.browserPath) {
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

electronShim.initialSidebarState = initialSidebarState;
electronShim.onMemoryNavigationChanged = (navigation) => {
  const path = navigation.location.pathname;
  if (
    navigation.action !== "POP" &&
    shouldUseMobileLayout() &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(path);
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  if (window.location.pathname === browserPath.path) {
    window.history.replaceState(undefined, "", browserPath.path);
    return;
  }

  window.history.pushState(undefined, "", browserPath.path);
};

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      if (isOpenInBrowserMessage(args[0])) {
        openUrlInEmbeddedBrowser(args[0].url);
        return Promise.resolve(undefined);
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args,
    });
  },
  postMessage(
    channel: string,
    message: unknown,
    transfer?: Transferable[],
  ): void {
    if (transfer && transfer.length > 0) {
      const portIds = transfer.map((transferable) => {
        if (!(transferable instanceof MessagePort)) {
          throw new TypeError(
            "Only MessagePort transfers are supported by the browser IPC bridge.",
          );
        }

        const portId = `message_port_${nextRequestId()}`;
        messagePorts.set(portId, transferable);
        transferable.addEventListener("message", (event) => {
          enqueueMessage({
            type: "message-port-message",
            portId,
            data: event.data,
          });
        });
        transferable.addEventListener("messageerror", () => {
          messagePorts.delete(portId);
          enqueueMessage({ type: "message-port-close", portId });
        });
        transferable.start();
        return portId;
      });

      enqueueMessage({
        type: "ipc-renderer-post-message",
        channel,
        message,
        portIds,
      });
      return;
    }

    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args: [message],
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-uses-owl-app-shell") {
      return false;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: { id: "local", display_name: "Local", kind: "local" },
        remote_ssh_connections: [],
        remote_wsl_connections: [],
        remote_control_connections_state: {
          available: false,
          accessRequired: false,
          authRequired: false,
          clientAuthorized: false,
        },
        local_remote_control_client_id: null,
        pending_worktrees: [],
      };
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    if (channel === "codex_desktop:get-initial-sidebar-bootstrap") {
      // The browser session has no synchronous bridge to the host-side catalog.
      // Returning no bootstrap lets the renderer populate it through the
      // existing asynchronous app-server stream.
      return null;
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ensureSocket();

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    return unimplemented("webUtils.getPathForFile");
  },
};
