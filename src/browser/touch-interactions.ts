const TOUCH_INPUT_ATTRIBUTE = "data-codex-touch-input";
const TOUCH_DRAGGING_ATTRIBUTE = "data-codex-touch-dragging";

const DRAG_ACTIVATION_DELAY_MS = 1_000;
const PRE_HOLD_MOVE_TOLERANCE_PX = 6;
const DRAG_START_DISTANCE_PX = 12;
const CLICK_SUPPRESSION_MS = 800;

const TOUCH_STYLES = `
html[${TOUCH_INPUT_ATTRIBUTE}="true"]
  :is(button, a, [role="button"], [class*="group-hover"]:has(:is(button, a, [role="button"])))
  [class*="group-hover"][class*="opacity-100"],
html[${TOUCH_INPUT_ATTRIBUTE}="true"]
  :is(button, a, [role="button"], [class*="group-hover"]:has(:is(button, a, [role="button"])))[class*="group-hover"][class*="opacity-100"] {
  opacity: 1 !important;
}

html[${TOUCH_INPUT_ATTRIBUTE}="true"]
  :is(button, a, [role="button"], [class*="group-hover"]:has(:is(button, a, [role="button"])))
  [class*="group-hover"][class*="pointer-events-auto"],
html[${TOUCH_INPUT_ATTRIBUTE}="true"]
  :is(button, a, [role="button"], [class*="group-hover"]:has(:is(button, a, [role="button"])))[class*="group-hover"][class*="pointer-events-auto"] {
  pointer-events: auto !important;
}

html[${TOUCH_INPUT_ATTRIBUTE}="true"]
  :is(button, a, [role="button"], [class*="group-hover"]:has(:is(button, a, [role="button"])))
  [class*="group-hover"][class*="visible"],
html[${TOUCH_INPUT_ATTRIBUTE}="true"]
  :is(button, a, [role="button"], [class*="group-hover"]:has(:is(button, a, [role="button"])))[class*="group-hover"][class*="visible"] {
  visibility: visible !important;
}

html[${TOUCH_INPUT_ATTRIBUTE}="true"]
  [class*="group-hover"]:has(:is(button, a, [role="button"]))[class*="w-auto"] {
  width: auto !important;
  overflow: visible !important;
  opacity: 1 !important;
  pointer-events: auto !important;
}

html[${TOUCH_INPUT_ATTRIBUTE}="true"]
  [data-clear-project-available]
  [data-clear-project-button] {
  opacity: 1 !important;
  pointer-events: auto !important;
}

html[${TOUCH_INPUT_ATTRIBUTE}="true"] [draggable="true"] {
  -webkit-touch-callout: none;
  user-select: none;
}

[${TOUCH_DRAGGING_ATTRIBUTE}="true"] {
  opacity: 0.65 !important;
}
`;

type DragSession = {
  currentTarget: Element | null;
  dataTransfer: DataTransfer;
  ghost: HTMLElement;
  offsetX: number;
  offsetY: number;
  source: HTMLElement;
};

type PointerGesture = {
  dragReady: boolean;
  dragReadyTimer: number | null;
  dragSession: DragSession | null;
  draggable: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
};

type SuppressedActivation = {
  expiresAt: number;
  target: HTMLElement;
};

let activeGesture: PointerGesture | null = null;
let suppressedActivation: SuppressedActivation | null = null;
let installed = false;

function setTouchInputMode(enabled: boolean): void {
  document.documentElement.setAttribute(
    TOUCH_INPUT_ATTRIBUTE,
    enabled ? "true" : "false",
  );
}

function installTouchStyles(): void {
  if (document.querySelector("style[data-codex-touch-interactions]")) {
    return;
  }

  const style = document.createElement("style");
  style.dataset.codexTouchInteractions = "true";
  style.textContent = TOUCH_STYLES;
  (document.head ?? document.documentElement).append(style);
}

function findNativeDraggable(target: Element): HTMLElement | null {
  const draggable = target.closest<HTMLElement>('[draggable="true"]');
  if (
    !draggable ||
    draggable.closest("[data-file-tree-virtualized-root]") ||
    draggable.matches(':disabled, [aria-disabled="true"]')
  ) {
    return null;
  }

  return draggable;
}

function createDataTransfer(): DataTransfer {
  try {
    return new DataTransfer();
  } catch {
    const values = new Map<string, string>();
    const fallback = {
      dropEffect: "none",
      effectAllowed: "all",
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      clearData(format?: string) {
        if (format == null) {
          values.clear();
        } else {
          values.delete(format);
        }
      },
      getData(format: string) {
        return values.get(format) ?? "";
      },
      setData(format: string, data: string) {
        values.set(format, data);
      },
      setDragImage() {},
    };
    Object.defineProperty(fallback, "types", {
      enumerable: true,
      get: () => Array.from(values.keys()),
    });
    return fallback as unknown as DataTransfer;
  }
}

function createDragEvent(
  type: string,
  pointerEvent: PointerEvent,
  dataTransfer: DataTransfer,
): DragEvent {
  const init: DragEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: pointerEvent.clientX,
    clientY: pointerEvent.clientY,
    dataTransfer,
    screenX: pointerEvent.screenX,
    screenY: pointerEvent.screenY,
  };

  try {
    return new DragEvent(type, init);
  } catch {
    const event = new MouseEvent(type, init) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    return event;
  }
}

function createDragGhost(
  source: HTMLElement,
  pointerEvent: PointerEvent,
): Pick<DragSession, "ghost" | "offsetX" | "offsetY"> {
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    height: `${rect.height}px`,
    left: "0",
    margin: "0",
    opacity: "0.82",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    width: `${rect.width}px`,
    zIndex: "2147483647",
  });
  document.body.append(ghost);

  return {
    ghost,
    offsetX: pointerEvent.clientX - rect.left,
    offsetY: pointerEvent.clientY - rect.top,
  };
}

function moveDragGhost(session: DragSession, pointerEvent: PointerEvent): void {
  session.ghost.style.transform = `translate3d(${pointerEvent.clientX - session.offsetX}px, ${pointerEvent.clientY - session.offsetY}px, 0)`;
}

function dispatchDragEvent(
  target: EventTarget,
  type: string,
  pointerEvent: PointerEvent,
  dataTransfer: DataTransfer,
): boolean {
  return target.dispatchEvent(
    createDragEvent(type, pointerEvent, dataTransfer),
  );
}

function startDrag(
  gesture: PointerGesture,
  pointerEvent: PointerEvent,
): DragSession | null {
  const source = gesture.draggable;
  if (!source) {
    return null;
  }

  const dataTransfer = createDataTransfer();
  dataTransfer.effectAllowed = "all";
  if (!dispatchDragEvent(source, "dragstart", pointerEvent, dataTransfer)) {
    return null;
  }

  const ghostParts = createDragGhost(source, pointerEvent);
  const session: DragSession = {
    currentTarget: null,
    dataTransfer,
    source,
    ...ghostParts,
  };
  source.setAttribute(TOUCH_DRAGGING_ATTRIBUTE, "true");
  moveDragGhost(session, pointerEvent);
  return session;
}

function updateDrag(session: DragSession, pointerEvent: PointerEvent): void {
  moveDragGhost(session, pointerEvent);
  dispatchDragEvent(session.source, "drag", pointerEvent, session.dataTransfer);

  const target = document.elementFromPoint(
    pointerEvent.clientX,
    pointerEvent.clientY,
  );
  if (target !== session.currentTarget) {
    if (session.currentTarget) {
      dispatchDragEvent(
        session.currentTarget,
        "dragleave",
        pointerEvent,
        session.dataTransfer,
      );
    }
    if (target) {
      dispatchDragEvent(
        target,
        "dragenter",
        pointerEvent,
        session.dataTransfer,
      );
    }
    session.currentTarget = target;
  }

  if (target) {
    dispatchDragEvent(target, "dragover", pointerEvent, session.dataTransfer);
  }
}

function finishDrag(
  session: DragSession,
  pointerEvent: PointerEvent,
  drop: boolean,
): void {
  if (drop && session.currentTarget) {
    dispatchDragEvent(
      session.currentTarget,
      "drop",
      pointerEvent,
      session.dataTransfer,
    );
  }
  dispatchDragEvent(
    session.source,
    "dragend",
    pointerEvent,
    session.dataTransfer,
  );
  session.source.removeAttribute(TOUCH_DRAGGING_ATTRIBUTE);
  session.ghost.remove();
}

function clearTimer(timer: number | null): void {
  if (timer !== null) {
    window.clearTimeout(timer);
  }
}

function clearGesture(pointerEvent?: PointerEvent, drop = false): void {
  const gesture = activeGesture;
  if (!gesture) {
    return;
  }

  clearTimer(gesture.dragReadyTimer);
  if (gesture.dragSession) {
    if (pointerEvent) {
      finishDrag(gesture.dragSession, pointerEvent, drop);
    } else {
      gesture.dragSession.source.removeAttribute(TOUCH_DRAGGING_ATTRIBUTE);
      gesture.dragSession.ghost.remove();
    }
  }
  activeGesture = null;
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === "mouse") {
    clearGesture();
    setTouchInputMode(false);
    return;
  }
  if (event.pointerType !== "touch" || !event.isPrimary || event.button !== 0) {
    return;
  }

  setTouchInputMode(true);
  clearGesture();
  const eventTarget = event.target;
  if (!(eventTarget instanceof Element)) {
    return;
  }

  const draggable = findNativeDraggable(eventTarget);
  if (!draggable) {
    return;
  }

  const gesture: PointerGesture = {
    dragReady: false,
    dragReadyTimer: null,
    dragSession: null,
    draggable,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
  };
  activeGesture = gesture;

  gesture.dragReadyTimer = window.setTimeout(() => {
    if (activeGesture === gesture) {
      gesture.dragReady = true;
    }
  }, DRAG_ACTIVATION_DELAY_MS);
}

function onPointerMove(event: PointerEvent): void {
  const gesture = activeGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) {
    return;
  }

  const distance = Math.hypot(
    event.clientX - gesture.startX,
    event.clientY - gesture.startY,
  );
  if (gesture.dragSession) {
    if (event.cancelable) {
      event.preventDefault();
    }
    updateDrag(gesture.dragSession, event);
    return;
  }

  if (!gesture.dragReady && distance > PRE_HOLD_MOVE_TOLERANCE_PX) {
    // Movement before the stationary hold completes always belongs to native
    // scrolling. The drag bridge must never reinterpret an active scroll.
    clearGesture();
    return;
  }

  if (gesture.dragReady && distance > DRAG_START_DISTANCE_PX) {
    gesture.dragSession = startDrag(gesture, event);
    if (gesture.dragSession) {
      if (event.cancelable) {
        event.preventDefault();
      }
      updateDrag(gesture.dragSession, event);
      return;
    }
  }
}

function onPointerUp(event: PointerEvent): void {
  const gesture = activeGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) {
    return;
  }

  if (gesture.dragSession) {
    suppressedActivation = {
      expiresAt: Date.now() + CLICK_SUPPRESSION_MS,
      target: gesture.dragSession.source,
    };
  }
  clearGesture(event, gesture.dragSession !== null);
}

function onPointerCancel(event: PointerEvent): void {
  if (activeGesture?.pointerId === event.pointerId) {
    clearGesture(event, false);
  }
}

function onClick(event: MouseEvent): void {
  const suppressed = suppressedActivation;
  if (!suppressed || Date.now() > suppressed.expiresAt) {
    suppressedActivation = null;
    return;
  }

  const target = event.target;
  if (
    target instanceof Node &&
    (suppressed.target.contains(target) || target.contains(suppressed.target))
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressedActivation = null;
  }
}

export function installTouchInteractions(): void {
  if (installed) {
    return;
  }
  installed = true;

  installTouchStyles();
  const coarsePointerQuery = matchMedia("(hover: none), (pointer: coarse)");
  if (coarsePointerQuery.matches) {
    setTouchInputMode(true);
  }
  coarsePointerQuery.addEventListener("change", (event) => {
    if (event.matches) {
      setTouchInputMode(true);
    }
  });

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, {
    capture: true,
    passive: false,
  });
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("lostpointercapture", onPointerCancel, true);
  document.addEventListener("click", onClick, true);
  window.addEventListener("blur", () => clearGesture());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      clearGesture();
    }
  });
}
