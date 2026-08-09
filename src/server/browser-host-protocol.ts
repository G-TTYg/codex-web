/**
 * Transport contract between the plain-Node codex-web server and the isolated
 * Electron process that owns real guest WebContents. Keep this module free of
 * Electron imports so both processes can validate the same message boundary.
 */

export type BrowserHostState = {
  canGoBack: boolean;
  canGoForward: boolean;
  historyIndex: number;
  isLoading: boolean;
  isLoadingMainFrame: boolean;
  title: string;
  url: string;
  zoomFactor: number;
};

export type BrowserEditableRect = {
  height: number;
  inputMode: string;
  width: number;
  x: number;
  y: number;
};

export type BrowserHostCreateOptions = {
  additionalArguments?: string[];
  height: number;
  ipcInvokeChannels: string[];
  partition: string;
  preloadPath?: string;
  sessionId: string;
  width: number;
};

export type BrowserHostCommand = {
  args: unknown[];
  method: string;
  requestId?: string;
  sessionId: string;
  type: "command";
};

export type ServerToBrowserHostMessage =
  | ({ type: "create" } & BrowserHostCreateOptions)
  | BrowserHostCommand
  | {
      errorMessage?: string;
      requestId: string;
      result?: unknown;
      type: "host-request-result";
    }
  | {
      sessionId: string;
      type: "destroy";
    }
  | {
      type: "shutdown";
    };

export type BrowserHostEventMessage = {
  args: unknown[];
  eventData?: Record<string, unknown>;
  name: string;
  sessionId: string;
  state: BrowserHostState;
  type: "event";
};

export type BrowserHostToServerMessage =
  | {
      electronVersion: string;
      type: "ready";
    }
  | {
      sessionId: string;
      state: BrowserHostState;
      type: "created";
    }
  | BrowserHostEventMessage
  | {
      data: Buffer;
      editableRects: BrowserEditableRect[];
      height: number;
      sessionId: string;
      type: "frame";
      width: number;
    }
  | {
      channel: string;
      args: unknown[];
      sessionId: string;
      type: "ipc-message";
    }
  | {
      details: Record<string, unknown>;
      requestId: string;
      sessionId: string;
      type: "before-request";
    }
  | {
      args: unknown[];
      channel: string;
      requestId: string;
      sessionId: string;
      type: "ipc-invoke";
    }
  | {
      errorMessage: string;
      requestId: string;
      sessionId: string;
      type: "command-error";
    }
  | {
      requestId: string;
      result: unknown;
      sessionId: string;
      type: "command-result";
    }
  | {
      errorMessage?: string;
      sessionId: string;
      type: "closed";
    };

export function isBrowserHostMessage(
  value: unknown,
): value is BrowserHostToServerMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const type = Reflect.get(value, "type");
  return (
    type === "ready" ||
    type === "created" ||
    type === "event" ||
    type === "frame" ||
    type === "ipc-message" ||
    type === "before-request" ||
    type === "ipc-invoke" ||
    type === "command-error" ||
    type === "command-result" ||
    type === "closed"
  );
}
