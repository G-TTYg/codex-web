import {
  hasTouchInputCapability,
  PHONE_LAYOUT_VIEWPORT_QUERY,
  shouldUseMobileUI,
  TOUCH_CAPABILITY_QUERY,
} from "./mobile-layout";

const MOBILE_UI_ATTRIBUTE = "data-codex-mobile-ui";
const TOUCH_CAPABILITY_ATTRIBUTE = "data-codex-touch-capable";
const TOUCH_INPUT_ATTRIBUTE = "data-codex-touch-input";
const CONTEXT_TARGET_SELECTOR = '[data-codex-context-target="true"]';
const OPEN_MENU_SELECTOR = '[role="menu"][data-state="open"]';
const PRIMARY_TOUCH_INPUT_QUERY = "(pointer: coarse), (hover: none)";
const ACTIVE_TOUCH_UI_SELECTOR = `html[${MOBILE_UI_ATTRIBUTE}="true"][${TOUCH_INPUT_ATTRIBUTE}="true"]`;

const MOBILE_INTERACTION_STYLES = `
/* Renderer-owned context alternatives are absent unless touch is the active
   input. A hybrid device therefore keeps the upstream Desktop UI for mouse. */
.codex-mobile-context-action {
  display: none !important;
}

${ACTIVE_TOUCH_UI_SELECTOR} .codex-mobile-context-action {
  align-items: center;
  box-sizing: border-box;
  display: inline-flex !important;
  flex: 0 0 32px;
  justify-content: center;
  max-height: 32px;
  max-width: 32px;
  min-height: 32px !important;
  min-width: 32px !important;
  padding: 0 !important;
  touch-action: pan-y !important;
}

/* Touch rows give content, status/loading, and actions separate natural flex
   slots. A missing status rail contributes no width, while a present rail uses
   only its real contents; the selected row still paints the complete width. */
${ACTIVE_TOUCH_UI_SELECTOR}
  [data-codex-row-layout]:has(.codex-mobile-context-action) {
  align-items: center;
  display: flex;
}

${ACTIVE_TOUCH_UI_SELECTOR}
  [data-codex-row-layout]:has(.codex-mobile-context-action)
  > [data-codex-row-content] {
  flex: 1 1 auto;
  min-width: 0;
  order: 0;
  width: auto !important;
}

/* The stable status rail is absolute upstream and therefore used to share the
   action's end coordinates. Its generated semantic marker lets touch layouts
   restore natural flow without coupling this shim to fingerprinted classes. */
${ACTIVE_TOUCH_UI_SELECTOR}
  [data-codex-row-layout]:has(.codex-mobile-context-action)
  > [data-codex-row-status-rail] {
  align-items: center !important;
  align-self: stretch;
  flex: 0 0 auto !important;
  height: auto !important;
  inset: auto !important;
  justify-content: center !important;
  min-width: 0 !important;
  order: 1;
  padding: 0 !important;
  position: static !important;
  z-index: 1;
}

/* The renderer action rail remains absolute for Desktop hover controls. Touch
   moves only this rail into the natural row flow and gives it one fixed lane. */
${ACTIVE_TOUCH_UI_SELECTOR}
  :is(div, span):has(> .codex-mobile-context-action),
${ACTIVE_TOUCH_UI_SELECTOR}
  :is(div, span):has(> .contents > .codex-mobile-context-action) {
  align-self: stretch;
  flex: 0 0 36px !important;
  gap: 0 !important;
  height: auto !important;
  inset: auto !important;
  justify-content: flex-end !important;
  margin: 0 !important;
  max-width: 36px !important;
  min-width: 36px !important;
  opacity: 1 !important;
  order: 2;
  padding: 0 !important;
  pointer-events: auto !important;
  position: static !important;
  visibility: visible !important;
  width: 36px !important;
  z-index: 1;
}

${ACTIVE_TOUCH_UI_SELECTOR}
  :is(div, span):has(> .codex-mobile-context-action)
  > :not(.codex-mobile-context-action) {
  display: none !important;
}

/* Tooltip slots are display:contents wrappers around each action. Hide their
   sibling slots at the rail level so pin/archive hover shortcuts cannot crowd
   the single mobile menu entry. */
${ACTIVE_TOUCH_UI_SELECTOR}
  :is(div, span):has(> .contents > .codex-mobile-context-action) {
  opacity: 1 !important;
  pointer-events: auto !important;
  visibility: visible !important;
}

${ACTIVE_TOUCH_UI_SELECTOR}
  :is(div, span):has(> .contents > .codex-mobile-context-action)
  > .contents:not(:has(.codex-mobile-context-action)) {
  display: none !important;
}

/* Keep renderer-owned menu controls visible where Desktop normally reveals
   them only on hover. The inline slot also needs its non-hover width restored;
   the original component, callbacks, menu styling and animation stay intact. */
${ACTIVE_TOUCH_UI_SELECTOR}
  :is(div, span)[class*="opacity-0"]:has([aria-haspopup="menu"]) {
  opacity: 1 !important;
  overflow: visible !important;
  pointer-events: auto !important;
  visibility: visible !important;
  flex: 0 0 auto !important;
  max-width: 100%;
  width: auto !important;
}

${ACTIVE_TOUCH_UI_SELECTOR}
  :is(div, span)[class*="pointer-events-none"]:has([aria-haspopup="menu"]) {
  pointer-events: auto !important;
}

${ACTIVE_TOUCH_UI_SELECTOR}
  :is(button, a, [role="button"])[aria-haspopup="menu"] {
  box-sizing: border-box;
  flex-shrink: 0;
  min-height: 30px;
  min-width: 30px;
  position: relative;
  touch-action: pan-y !important;
  z-index: 1;
}

/* A touch sequence on a draggable row remains native vertical panning. These
   styles follow capability, while drag cancellation follows the active input,
   so a hardware mouse on a hybrid display retains Desktop dragging. */
html[${TOUCH_CAPABILITY_ATTRIBUTE}="true"] [draggable="true"] {
  -webkit-touch-callout: none;
  -webkit-user-drag: none !important;
  touch-action: pan-y pinch-zoom;
  user-select: none;
}

html[${TOUCH_CAPABILITY_ATTRIBUTE}="true"] [data-app-action-sidebar-scroll],
html[${TOUCH_CAPABILITY_ATTRIBUTE}="true"] [data-file-tree-virtualized-scroll] {
  -webkit-overflow-scrolling: touch;
  min-height: 0;
  overflow-y: auto !important;
  overscroll-behavior-y: contain;
  touch-action: pan-y pinch-zoom !important;
}

html[${TOUCH_CAPABILITY_ATTRIBUTE}="true"] [data-app-action-sidebar-scroll] *,
html[${TOUCH_CAPABILITY_ATTRIBUTE}="true"] [data-file-tree-virtualized-scroll] * {
  -webkit-user-drag: none !important;
  touch-action: pan-y pinch-zoom !important;
}

/* Right-panel tab menus are normally secondary-click-only. The renderer adds a
   dedicated inline touch action that opens the original Radix context menu. */
.codex-mobile-tab-context-action {
  display: none !important;
}

${ACTIVE_TOUCH_UI_SELECTOR}
  aside[data-app-shell-focus-area="right-panel"]
  [data-app-shell-tab-close-button] {
  display: none !important;
}

${ACTIVE_TOUCH_UI_SELECTOR}
  aside[data-app-shell-focus-area="right-panel"]
  .codex-mobile-tab-context-action {
  align-items: center;
  color: var(--color-token-text-tertiary);
  display: inline-flex !important;
  inset-block: 0;
  inset-inline-end: 1px;
  justify-content: center;
  max-width: 32px;
  min-height: 28px;
  min-width: 28px;
  padding: 0;
  position: absolute;
  touch-action: pan-x !important;
  width: 32px;
  z-index: 31;
}

${ACTIVE_TOUCH_UI_SELECTOR}
  aside[data-app-shell-focus-area="right-panel"]
  [data-app-shell-tab-controller]:has(.codex-mobile-tab-context-action)
  button[role="tab"] {
  box-sizing: border-box;
  min-width: 0;
  padding-inline-end: 36px !important;
}
`;

type MobileElectronShim = {
  openContextMenuFromButton?: (button: HTMLElement) => void;
};

type MobileWindow = Window & {
  __ELECTRON_SHIM__?: MobileElectronShim;
};

let installed = false;
let contextMenuOpenRequest = 0;

function installStyles(): void {
  if (document.querySelector("style[data-codex-mobile-interactions]")) {
    return;
  }

  const style = document.createElement("style");
  style.dataset.codexMobileInteractions = "true";
  style.textContent = MOBILE_INTERACTION_STYLES;
  (document.head ?? document.documentElement).append(style);
}

function setAttribute(name: string, enabled: boolean): void {
  document.documentElement.setAttribute(name, enabled ? "true" : "false");
}

function touchInputEnabled(): boolean {
  return (
    document.documentElement.getAttribute(TOUCH_INPUT_ATTRIBUTE) === "true"
  );
}

function hasWebKitTouchInput(): boolean {
  return (
    navigator.maxTouchPoints > 0 &&
    typeof CSS !== "undefined" &&
    CSS.supports("-webkit-touch-callout", "none")
  );
}

function dispatchContextMenu(
  target: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  if (!target.isConnected) {
    return;
  }

  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      button: 2,
      cancelable: true,
      clientX,
      clientY,
      view: window,
    }),
  );
}

function dismissOpenMenu(): boolean {
  const openMenus = document.querySelectorAll<HTMLElement>(OPEN_MENU_SELECTOR);
  const openMenu = openMenus.item(openMenus.length - 1);
  if (!openMenu) {
    return false;
  }

  // Let the renderer's Radix layer own dismissal, focus restoration and exit
  // animation. This matches a hardware secondary click switching menu targets.
  const activeElement = document.activeElement;
  const escapeTarget =
    activeElement instanceof HTMLElement && openMenu.contains(activeElement)
      ? activeElement
      : openMenu;
  escapeTarget.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Escape",
      composed: true,
      key: "Escape",
    }),
  );
  return true;
}

function openAfterMenusDismiss(
  request: number,
  target: HTMLElement,
  clientX: number,
  clientY: number,
  remainingFrames = 8,
): void {
  if (request !== contextMenuOpenRequest) {
    return;
  }
  if (!dismissOpenMenu()) {
    dispatchContextMenu(target, clientX, clientY);
    return;
  }
  if (remainingFrames <= 0) {
    return;
  }

  // A root menu and its submenu can both be open. Close the topmost layer one
  // frame at a time until no native menu remains, while retaining only the most
  // recent tap if the user changes targets during the exit animation.
  requestAnimationFrame(() => {
    openAfterMenusDismiss(
      request,
      target,
      clientX,
      clientY,
      remainingFrames - 1,
    );
  });
}

function openContextMenuFromButton(button: HTMLElement): void {
  // Some renderer row components forward onContextMenu but intentionally omit
  // unknown data attributes. Their existing role-bearing root is therefore the
  // fallback dispatch target for the same React/Radix handler.
  const target =
    button.closest<HTMLElement>(CONTEXT_TARGET_SELECTOR) ??
    button
      .closest<HTMLElement>("[data-app-shell-tab-controller]")
      ?.querySelector<HTMLElement>(CONTEXT_TARGET_SELECTOR) ??
    button.parentElement?.closest<HTMLElement>(
      '[role="button"], [role="treeitem"], [data-thread-title-trigger]',
    );
  if (!target?.isConnected) {
    return;
  }

  const rect = button.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = Math.min(window.innerHeight - 8, rect.bottom);
  const request = ++contextMenuOpenRequest;
  openAfterMenusDismiss(request, target, clientX, clientY);
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === "mouse") {
    setAttribute(TOUCH_INPUT_ATTRIBUTE, false);
    return;
  }
  if (event.pointerType === "touch" || event.pointerType === "pen") {
    setAttribute(TOUCH_INPUT_ATTRIBUTE, true);
  }
}

function onDragStart(event: DragEvent): void {
  if (!touchInputEnabled()) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
}

export function installMobileInteractions(): void {
  if (installed) {
    return;
  }
  installed = true;
  installStyles();

  const shimWindow = window as MobileWindow;
  const electronShim = (shimWindow.__ELECTRON_SHIM__ ??= {});
  electronShim.openContextMenuFromButton = openContextMenuFromButton;

  const primaryTouchInputQuery = matchMedia(PRIMARY_TOUCH_INPUT_QUERY);
  const capabilityQueries = [
    matchMedia(PHONE_LAYOUT_VIEWPORT_QUERY),
    matchMedia(TOUCH_CAPABILITY_QUERY),
    primaryTouchInputQuery,
  ];
  let inputModeWasExplicitlySelected = false;
  const updateMobileMode = (): void => {
    const touchCapable = hasTouchInputCapability();
    setAttribute(MOBILE_UI_ATTRIBUTE, shouldUseMobileUI());
    setAttribute(TOUCH_CAPABILITY_ATTRIBUTE, touchCapable);
    if (!inputModeWasExplicitlySelected) {
      // iPadOS desktop-site mode can expose a fine primary pointer despite
      // remaining a WebKit touch device. Hybrid desktops stay in their mouse
      // UI until an actual touch/pen sequence occurs.
      setAttribute(
        TOUCH_INPUT_ATTRIBUTE,
        primaryTouchInputQuery.matches || hasWebKitTouchInput(),
      );
    }
  };
  updateMobileMode();
  for (const query of capabilityQueries) {
    query.addEventListener("change", updateMobileMode);
  }

  document.addEventListener(
    "touchstart",
    () => {
      // iPadOS WebKit can expose a touch-capable device while reporting its
      // compatibility pointer sequence as mouse. TouchEvent is authoritative
      // here and restores the inline alternatives before the completed tap.
      inputModeWasExplicitlySelected = true;
      setAttribute(TOUCH_INPUT_ATTRIBUTE, true);
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      inputModeWasExplicitlySelected = true;
      onPointerDown(event);
    },
    true,
  );
  document.addEventListener("dragstart", onDragStart, true);
}
