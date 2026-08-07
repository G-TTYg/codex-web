const TOUCH_INPUT_ATTRIBUTE = "data-codex-touch-input";

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

/* Touch rows are scroll surfaces, never HTML drag sources. */
html[${TOUCH_INPUT_ATTRIBUTE}="true"] [draggable="true"] {
  -webkit-touch-callout: none;
  -webkit-user-drag: none !important;
  touch-action: pan-y pinch-zoom;
  user-select: none;
}
`;

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

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === "touch") {
    setTouchInputMode(true);
  } else if (event.pointerType === "mouse") {
    // Hybrid devices keep ordinary desktop dragging when a mouse is in use.
    setTouchInputMode(false);
  }
}

function onDragStart(event: DragEvent): void {
  if (document.documentElement.getAttribute(TOUCH_INPUT_ATTRIBUTE) !== "true") {
    return;
  }

  // iPadOS may still synthesize HTML drag events for draggable rows. Cancelling
  // them in capture keeps the gesture owned by native vertical scrolling.
  event.preventDefault();
  event.stopImmediatePropagation();
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

  // These capture listeners only track the active input modality and cancel
  // dragstart; they never cancel pointer movement or native scrolling.
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("dragstart", onDragStart, true);
}
