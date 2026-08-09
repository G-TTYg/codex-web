/**
 * Browser-side surface for Electron's <webview> contract. Remote pages stay in
 * the host's isolated Electron process; this element only paints frames and
 * forwards explicit input, so arbitrary sites do not depend on iframe policy.
 */

type BrowserEditableRect = {
  height: number;
  inputMode: string;
  width: number;
  x: number;
  y: number;
};

export type BrowserWebviewRendererMessage =
  | {
      height: number;
      instanceId: number;
      params: Record<string, string | number>;
      type: "browser-webview-create";
      viewId: string;
      width: number;
    }
  | {
      args: unknown[];
      method: string;
      type: "browser-webview-command";
      viewId: string;
    }
  | {
      type: "browser-webview-destroy";
      viewId: string;
    };

export type BrowserWebviewMainMessage =
  | {
      type: "browser-webview-attached";
      viewId: string;
    }
  | {
      data: string;
      editableRects: BrowserEditableRect[];
      height: number;
      type: "browser-webview-frame";
      viewId: string;
      width: number;
    }
  | {
      errorMessage?: string;
      type: "browser-webview-closed";
      viewId: string;
    };

type SendMessage = (message: BrowserWebviewRendererMessage) => void;

type ViewState = {
  attached: boolean;
  closed: boolean;
  destroyTimer: number | null;
  editableRects: BrowserEditableRect[];
  element: HTMLElement;
  frameHeight: number;
  frameWidth: number;
  image: HTMLImageElement;
  instanceId: number;
  keyboardInput: HTMLTextAreaElement;
  resizeObserver: ResizeObserver | null;
  viewId: string;
};

const views = new Map<string, ViewState>();
const statesByElement = new WeakMap<HTMLElement, ViewState>();
let sendMessage: SendMessage | null = null;
let instanceSequence = 0;
let installed = false;

export function installBrowserWebviews(send: SendMessage): void {
  sendMessage = send;
  if (installed) {
    return;
  }
  installed = true;

  const originalCreateElement = Document.prototype.createElement;
  Document.prototype.createElement = function createElement(
    qualifiedName: string,
    options?: ElementCreationOptions,
  ): HTMLElement {
    const element = originalCreateElement.call(this, qualifiedName, options);
    if (qualifiedName.toLowerCase() === "webview") {
      enhanceWebview(element);
    }
    return element;
  } as typeof Document.prototype.createElement;

  const mountObserver = new MutationObserver(() => {
    for (const state of views.values()) {
      syncConnection(state);
    }
  });
  mountObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

export function handleBrowserWebviewMessage(value: unknown): boolean {
  if (!isBrowserWebviewMainMessage(value)) {
    return false;
  }
  const state = views.get(value.viewId);
  if (!state) {
    return true;
  }

  if (value.type === "browser-webview-attached") {
    state.attached = true;
    state.element.dispatchEvent(new Event("did-attach"));
    syncSize(state);
    return true;
  }
  if (value.type === "browser-webview-frame") {
    state.frameWidth = value.width;
    state.frameHeight = value.height;
    state.editableRects = value.editableRects;
    state.image.src = `data:image/jpeg;base64,${value.data}`;
    return true;
  }

  state.attached = false;
  state.closed = true;
  state.resizeObserver?.disconnect();
  views.delete(state.viewId);
  state.element.dispatchEvent(
    new CustomEvent("destroyed", {
      detail: { errorMessage: value.errorMessage ?? null },
    }),
  );
  return true;
}

export function markBrowserWebviewsDisconnected(): void {
  for (const state of views.values()) {
    state.attached = false;
  }
}

export function reconnectBrowserWebviews(): void {
  for (const state of views.values()) {
    if (!state.closed) {
      syncConnection(state);
    }
  }
}

function enhanceWebview(element: HTMLElement): void {
  if (statesByElement.has(element)) {
    return;
  }
  const viewId = crypto.randomUUID();
  const shadow = element.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host {
      contain: strict;
      display: block;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      touch-action: none;
    }
    img {
      display: block;
      height: 100%;
      object-fit: fill;
      pointer-events: auto;
      user-select: none;
      width: 100%;
      -webkit-user-drag: none;
    }
    textarea {
      background: transparent;
      border: 0;
      caret-color: transparent;
      height: 1px;
      margin: 0;
      opacity: 0.01;
      padding: 0;
      pointer-events: none;
      position: absolute;
      resize: none;
      width: 1px;
      z-index: -1;
    }
  `;
  const image = document.createElement("img");
  image.alt = "";
  image.draggable = false;
  const keyboardInput = document.createElement("textarea");
  keyboardInput.autocapitalize = "off";
  keyboardInput.autocomplete = "off";
  keyboardInput.spellcheck = false;
  shadow.append(style, image, keyboardInput);

  if (!element.hasAttribute("tabindex")) {
    element.tabIndex = 0;
  }
  element.setAttribute("role", "document");
  const state: ViewState = {
    attached: false,
    closed: false,
    destroyTimer: null,
    editableRects: [],
    element,
    frameHeight: 720,
    frameWidth: 1280,
    image,
    instanceId: ++instanceSequence,
    keyboardInput,
    resizeObserver:
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => syncSize(state))
        : null,
    viewId,
  };
  statesByElement.set(element, state);
  views.set(viewId, state);
  installPointerInput(state);
  installKeyboardInput(state);
  queueMicrotask(() => syncConnection(state));
}

function syncConnection(state: ViewState): void {
  if (state.element.isConnected) {
    if (state.destroyTimer !== null) {
      clearTimeout(state.destroyTimer);
      state.destroyTimer = null;
    }
    if (state.attached || state.closed) {
      return;
    }
    state.attached = true;
    state.resizeObserver?.observe(state.element);
    const rect = state.element.getBoundingClientRect();
    const params: Record<string, string | number> = {
      instanceId: state.instanceId,
    };
    for (const attribute of state.element.attributes) {
      params[attribute.name] = attribute.value;
    }
    sendMessage?.({
      type: "browser-webview-create",
      viewId: state.viewId,
      instanceId: state.instanceId,
      params,
      width: validDimension(rect.width, 1280),
      height: validDimension(rect.height, 720),
    });
    return;
  }

  if (!state.attached || state.destroyTimer !== null) {
    return;
  }
  state.destroyTimer = window.setTimeout(() => {
    state.destroyTimer = null;
    if (state.element.isConnected) {
      return;
    }
    state.attached = false;
    state.resizeObserver?.disconnect();
    sendMessage?.({ type: "browser-webview-destroy", viewId: state.viewId });
    views.delete(state.viewId);
  }, 500);
}

function syncSize(state: ViewState): void {
  if (!state.attached || !state.element.isConnected) {
    return;
  }
  const rect = state.element.getBoundingClientRect();
  sendCommand(state, "resize", [
    validDimension(rect.width, 1280),
    validDimension(rect.height, 720),
  ]);
}

function validDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function installPointerInput(state: ViewState): void {
  let activePointerId: number | null = null;
  let pointerType = "mouse";
  let lastClickAt = 0;
  let lastClickX = 0;
  let lastClickY = 0;
  let clickCount = 0;

  state.image.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    activePointerId = event.pointerId;
    pointerType = event.pointerType;
    state.image.setPointerCapture?.(event.pointerId);
    const point = remotePoint(state, event.clientX, event.clientY);
    const now = performance.now();
    if (
      now - lastClickAt < 500 &&
      Math.hypot(point.x - lastClickX, point.y - lastClickY) < 5
    ) {
      clickCount += 1;
    } else {
      clickCount = 1;
    }
    lastClickAt = now;
    lastClickX = point.x;
    lastClickY = point.y;

    const editable = findEditableRect(state, point.x, point.y);
    if (event.pointerType === "touch" && editable) {
      focusSoftwareKeyboard(state, editable, event.offsetX, event.offsetY);
    } else {
      state.keyboardInput.blur();
      state.element.focus({ preventScroll: true });
    }

    if (event.pointerType === "touch") {
      sendCommand(state, "sendInputEvent", [
        { type: "touchStart", touch: point },
      ]);
    } else {
      sendCommand(state, "sendInputEvent", [
        {
          type: "mouseDown",
          ...point,
          button: pointerButton(event.button),
          clickCount,
          modifiers: pointerModifiers(event),
        },
      ]);
    }
  });

  state.image.addEventListener("pointermove", (event) => {
    const point = remotePoint(state, event.clientX, event.clientY);
    if (event.pointerType === "touch") {
      if (activePointerId === event.pointerId) {
        event.preventDefault();
        sendCommand(state, "sendInputEvent", [
          { type: "touchMove", touch: point },
        ]);
      }
      return;
    }
    sendCommand(state, "sendInputEvent", [
      {
        type: "mouseMove",
        ...point,
        button: event.buttons === 0 ? "none" : pointerButton(event.button),
        modifiers: pointerModifiers(event),
      },
    ]);
  });

  const finishPointer = (event: PointerEvent, cancelled: boolean): void => {
    if (activePointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const point = remotePoint(state, event.clientX, event.clientY);
    if (pointerType === "touch") {
      sendCommand(state, "sendInputEvent", [
        { type: cancelled ? "touchCancel" : "touchEnd", touch: point },
      ]);
    } else {
      sendCommand(state, "sendInputEvent", [
        {
          type: "mouseUp",
          ...point,
          button: pointerButton(event.button),
          clickCount,
          modifiers: pointerModifiers(event),
        },
      ]);
    }
    activePointerId = null;
  };
  state.image.addEventListener("pointerup", (event) =>
    finishPointer(event, false),
  );
  state.image.addEventListener("pointercancel", (event) =>
    finishPointer(event, true),
  );
  state.image.addEventListener("contextmenu", (event) =>
    event.preventDefault(),
  );
  state.image.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const point = remotePoint(state, event.clientX, event.clientY);
      sendCommand(state, "sendInputEvent", [
        {
          type: "mouseWheel",
          ...point,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          canScroll: true,
          modifiers: pointerModifiers(event),
        },
      ]);
    },
    { passive: false },
  );
}

function installKeyboardInput(state: ViewState): void {
  state.element.addEventListener("keydown", (event) => {
    if (event.target === state.keyboardInput) {
      return;
    }
    sendKeyEvent(state, "keyDown", event);
  });
  state.element.addEventListener("keyup", (event) => {
    if (event.target === state.keyboardInput) {
      return;
    }
    sendKeyEvent(state, "keyUp", event);
  });

  let composing = false;
  state.keyboardInput.addEventListener("compositionstart", () => {
    composing = true;
  });
  state.keyboardInput.addEventListener("compositionend", (event) => {
    composing = false;
    if (event.data) {
      sendCommand(state, "insertText", [event.data]);
    }
    state.keyboardInput.value = "";
  });
  state.keyboardInput.addEventListener("beforeinput", (event) => {
    event.preventDefault();
    if (composing || event.inputType === "insertCompositionText") {
      return;
    }
    if (event.data) {
      sendCommand(state, "insertText", [event.data]);
    } else if (event.inputType === "deleteContentBackward") {
      sendSimpleKey(state, "Backspace");
    } else if (
      event.inputType === "insertLineBreak" ||
      event.inputType === "insertParagraph"
    ) {
      sendSimpleKey(state, "Enter");
    }
    state.keyboardInput.value = "";
  });
  state.keyboardInput.addEventListener("keydown", (event) => {
    if (
      event.key === "Backspace" ||
      event.key === "Enter" ||
      event.key === "Tab" ||
      event.key === "Escape" ||
      event.key.startsWith("Arrow")
    ) {
      event.preventDefault();
      sendKeyEvent(state, "keyDown", event);
      sendKeyEvent(state, "keyUp", event);
    }
  });
}

function focusSoftwareKeyboard(
  state: ViewState,
  editable: BrowserEditableRect,
  localX: number,
  localY: number,
): void {
  state.keyboardInput.style.left = `${Math.max(0, localX)}px`;
  state.keyboardInput.style.top = `${Math.max(0, localY)}px`;
  state.keyboardInput.inputMode = normalizeInputMode(editable.inputMode);
  state.keyboardInput.focus({ preventScroll: true });
}

function normalizeInputMode(
  value: string,
):
  | "none"
  | "text"
  | "decimal"
  | "numeric"
  | "tel"
  | "search"
  | "email"
  | "url" {
  switch (value) {
    case "none":
    case "decimal":
    case "numeric":
    case "tel":
    case "search":
    case "email":
    case "url":
      return value;
    default:
      return "text";
  }
}

function findEditableRect(
  state: ViewState,
  x: number,
  y: number,
): BrowserEditableRect | null {
  return (
    state.editableRects.find(
      (rect) =>
        x >= rect.x &&
        y >= rect.y &&
        x <= rect.x + rect.width &&
        y <= rect.y + rect.height,
    ) ?? null
  );
}

function remotePoint(
  state: ViewState,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = state.element.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(
        state.frameWidth,
        ((clientX - rect.left) / Math.max(1, rect.width)) * state.frameWidth,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        state.frameHeight,
        ((clientY - rect.top) / Math.max(1, rect.height)) * state.frameHeight,
      ),
    ),
  };
}

function pointerButton(button: number): "left" | "middle" | "right" | "none" {
  if (button === 1) {
    return "middle";
  }
  if (button === 2) {
    return "right";
  }
  if (button === 0) {
    return "left";
  }
  return "none";
}

function pointerModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): string[] {
  return [
    event.altKey ? "alt" : null,
    event.ctrlKey ? "control" : null,
    event.metaKey ? "meta" : null,
    event.shiftKey ? "shift" : null,
  ].filter((modifier): modifier is string => modifier !== null);
}

function sendKeyEvent(
  state: ViewState,
  type: "keyDown" | "keyUp",
  event: KeyboardEvent,
): void {
  if (event.isComposing) {
    return;
  }
  sendCommand(state, "sendInputEvent", [
    {
      type,
      keyCode: event.key,
      code: event.code,
      modifiers: pointerModifiers(event),
    },
  ]);
}

function sendSimpleKey(state: ViewState, keyCode: string): void {
  sendCommand(state, "sendInputEvent", [{ type: "keyDown", keyCode }]);
  sendCommand(state, "sendInputEvent", [{ type: "keyUp", keyCode }]);
}

function sendCommand(state: ViewState, method: string, args: unknown[]): void {
  if (!state.attached) {
    return;
  }
  sendMessage?.({
    type: "browser-webview-command",
    viewId: state.viewId,
    method,
    args,
  });
}

function isBrowserWebviewMainMessage(
  value: unknown,
): value is BrowserWebviewMainMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const type = Reflect.get(value, "type");
  return (
    typeof Reflect.get(value, "viewId") === "string" &&
    (type === "browser-webview-attached" ||
      type === "browser-webview-frame" ||
      type === "browser-webview-closed")
  );
}
