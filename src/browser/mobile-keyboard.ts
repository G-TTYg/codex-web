/**
 * Stabilizes the browser app shell around software-keyboard transitions.
 *
 * The Desktop renderer sizes body and #root to 100vh. Software keyboards only
 * shrink the Visual Viewport on mobile WebKit, so the composer otherwise stays
 * at the bottom of the obscured Desktop-height shell. While a keyboard is
 * confirmed open, pin the whole app shell to the Visual Viewport. On close,
 * normalize only the document root; renderer-owned conversation and editor
 * scrollers retain their positions.
 */

import { hasTouchInputCapability } from "./mobile-layout";

const EDITABLE_SELECTOR = [
  "textarea",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
  "input:not([type])",
  'input[type="date"]',
  'input[type="datetime-local"]',
  'input[type="email"]',
  'input[type="month"]',
  'input[type="number"]',
  'input[type="password"]',
  'input[type="search"]',
  'input[type="tel"]',
  'input[type="text"]',
  'input[type="time"]',
  'input[type="url"]',
  'input[type="week"]',
].join(", ");
const KEYBOARD_ATTRIBUTE = "data-codex-software-keyboard";
const KEYBOARD_HEIGHT_PROPERTY = "--codex-keyboard-viewport-height";
const KEYBOARD_LEFT_PROPERTY = "--codex-keyboard-viewport-left";
const KEYBOARD_TOP_PROPERTY = "--codex-keyboard-viewport-top";
const KEYBOARD_WIDTH_PROPERTY = "--codex-keyboard-viewport-width";
const KEYBOARD_HEIGHT_THRESHOLD_PX = 80;
const VIEWPORT_WIDTH_EPSILON_PX = 2;
const RESTORE_DELAY_MS = 160;

const KEYBOARD_VIEWPORT_STYLES = `
html[${KEYBOARD_ATTRIBUTE}="true"] {
  overflow: hidden !important;
}

html[${KEYBOARD_ATTRIBUTE}="true"] body {
  position: fixed !important;
  inset: auto !important;
  top: var(${KEYBOARD_TOP_PROPERTY}, 0px) !important;
  left: var(${KEYBOARD_LEFT_PROPERTY}, 0px) !important;
  width: var(${KEYBOARD_WIDTH_PROPERTY}, 100%) !important;
  height: var(${KEYBOARD_HEIGHT_PROPERTY}, 100%) !important;
  min-height: 0 !important;
  max-height: var(${KEYBOARD_HEIGHT_PROPERTY}, 100%) !important;
  overflow: hidden !important;
}

html[${KEYBOARD_ATTRIBUTE}="true"] #root {
  width: 100% !important;
  height: 100% !important;
  min-height: 0 !important;
  max-height: 100% !important;
}
`;

let installed = false;

type ViewportSize = {
  height: number;
  layoutWidth: number;
  left: number;
  top: number;
  width: number;
};

function viewportSize(): ViewportSize {
  const viewport = window.visualViewport;
  return {
    height: viewport?.height ?? window.innerHeight,
    // The visual viewport can narrow while a keyboard or its accessory UI is
    // animating. The layout viewport changes only for rotation, split view, or
    // a real window resize, which are the baseline changes relevant here.
    layoutWidth: window.innerWidth,
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
  };
}

function installKeyboardViewportStyles(): void {
  if (document.querySelector("style[data-codex-mobile-keyboard]")) {
    return;
  }

  const style = document.createElement("style");
  style.dataset.codexMobileKeyboard = "true";
  style.textContent = KEYBOARD_VIEWPORT_STYLES;
  (document.head ?? document.documentElement).append(style);
}

function setKeyboardViewport(viewport: ViewportSize): void {
  const root = document.documentElement;
  root.style.setProperty(KEYBOARD_HEIGHT_PROPERTY, `${viewport.height}px`);
  root.style.setProperty(KEYBOARD_LEFT_PROPERTY, `${viewport.left}px`);
  root.style.setProperty(KEYBOARD_TOP_PROPERTY, `${viewport.top}px`);
  root.style.setProperty(KEYBOARD_WIDTH_PROPERTY, `${viewport.width}px`);
}

function clearKeyboardViewport(): void {
  const root = document.documentElement;
  root.style.removeProperty(KEYBOARD_HEIGHT_PROPERTY);
  root.style.removeProperty(KEYBOARD_LEFT_PROPERTY);
  root.style.removeProperty(KEYBOARD_TOP_PROPERTY);
  root.style.removeProperty(KEYBOARD_WIDTH_PROPERTY);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const editable = target.closest(EDITABLE_SELECTOR);
  if (editable === null) {
    return false;
  }

  return (
    !(
      editable instanceof HTMLInputElement ||
      editable instanceof HTMLTextAreaElement
    ) ||
    (!editable.disabled && !editable.readOnly)
  );
}

function keyboardViewportEnabled(): boolean {
  // Keyboard geometry follows device capability, not the most recent pointer.
  // An iPad trackpad click or a hybrid laptop mouse can still summon the same
  // software keyboard after focus reaches an editable surface.
  return hasTouchInputCapability();
}

function resetRootScroll(): void {
  // window.scrollTo is the operation that clears WebKit's layout-viewport
  // pan. Explicit element assignments cover engines whose scrolling root is
  // exposed separately and intentionally leave nested app scrollers alone.
  window.scrollTo(0, 0);
  const roots = [
    document.scrollingElement,
    document.documentElement,
    document.body,
  ];
  for (const root of roots) {
    if (root !== null) {
      root.scrollLeft = 0;
      root.scrollTop = 0;
    }
  }
}

export function installMobileKeyboardViewport(): void {
  if (installed) {
    return;
  }
  installed = true;
  installKeyboardViewportStyles();

  let baseline = viewportSize();
  let minimumSessionHeight = baseline.height;
  let keyboardWasOpen = false;
  let editorSessionActive = false;
  let restoreTimer: number | null = null;
  let restoreGeneration = 0;

  const setKeyboardOpen = (open: boolean): void => {
    document.documentElement.setAttribute(
      KEYBOARD_ATTRIBUTE,
      open ? "true" : "false",
    );
  };

  const cancelRestore = (): void => {
    // A timer may already have handed work to requestAnimationFrame. Advancing
    // the generation also invalidates those queued frames when a new input is
    // focused or the keyboard begins changing size again.
    restoreGeneration += 1;
    if (restoreTimer !== null) {
      window.clearTimeout(restoreTimer);
      restoreTimer = null;
    }
  };

  const restoreAfterAnimation = (): void => {
    // A plain focus transition must never move the page. Root normalization is
    // only valid after this session actually observed keyboard occlusion.
    if (!keyboardWasOpen) {
      return;
    }

    cancelRestore();
    const generation = restoreGeneration;
    restoreTimer = window.setTimeout(() => {
      restoreTimer = null;
      if (generation !== restoreGeneration || !keyboardWasOpen) {
        return;
      }

      const current = viewportSize();
      if (
        current.height - minimumSessionHeight <
        KEYBOARD_HEIGHT_THRESHOLD_PX
      ) {
        return;
      }

      // Two frames let the final Visual Viewport resize update the layout
      // before clearing Safari's residual root offset. Each frame rechecks the
      // generation so a newly focused editor cannot be moved by stale work.
      window.requestAnimationFrame(() => {
        if (generation !== restoreGeneration || !keyboardWasOpen) {
          return;
        }
        window.requestAnimationFrame(() => {
          if (generation !== restoreGeneration || !keyboardWasOpen) {
            return;
          }
          keyboardWasOpen = false;
          setKeyboardOpen(false);
          clearKeyboardViewport();
          resetRootScroll();
          baseline = viewportSize();
          minimumSessionHeight = baseline.height;
          editorSessionActive = isEditableTarget(document.activeElement);
        });
      });
    }, RESTORE_DELAY_MS);
  };

  const handleViewportChange = (): void => {
    if (!keyboardViewportEnabled()) {
      return;
    }

    const current = viewportSize();
    if (keyboardWasOpen) {
      // Visual Viewport scroll events continue while WebKit pans the focused
      // editor. Keep the fixed shell aligned with every animation step.
      setKeyboardViewport(current);
    }
    if (
      Math.abs(current.layoutWidth - baseline.layoutWidth) >
      VIEWPORT_WIDTH_EPSILON_PX
    ) {
      // Rotation and split-view resizing establish a new non-keyboard
      // baseline instead of being mistaken for vertical keyboard occlusion.
      cancelRestore();
      baseline = current;
      minimumSessionHeight = current.height;
      if (keyboardWasOpen) {
        return;
      }
    }

    if (!editorSessionActive && !keyboardWasOpen) {
      baseline = current;
      minimumSessionHeight = current.height;
      return;
    }

    minimumSessionHeight = Math.min(minimumSessionHeight, current.height);

    if (baseline.height - current.height >= KEYBOARD_HEIGHT_THRESHOLD_PX) {
      cancelRestore();
      keyboardWasOpen = true;
      setKeyboardViewport(current);
      setKeyboardOpen(true);
      return;
    }

    if (
      keyboardWasOpen &&
      current.height - minimumSessionHeight >= KEYBOARD_HEIGHT_THRESHOLD_PX
    ) {
      // Keep the shell pinned until WebKit has finished expanding the Visual
      // Viewport. Removing the constraint during the close animation exposes
      // the renderer's 100vh shell and causes the same disappearing jump.
      restoreAfterAnimation();
    }
  };

  document.addEventListener(
    "focusin",
    (event) => {
      if (!keyboardViewportEnabled() || !isEditableTarget(event.target)) {
        return;
      }

      cancelRestore();
      editorSessionActive = true;
      const current = viewportSize();
      if (!keyboardWasOpen) {
        // Keep the last no-editor height as the keyboard baseline. WebKit may
        // dispatch focusin after the first Visual Viewport animation step; if
        // that already-shortened height became the baseline, the remaining
        // animation could stay below the detection threshold forever.
        minimumSessionHeight = Math.min(baseline.height, current.height);
        handleViewportChange();
      }
    },
    true,
  );

  document.addEventListener(
    "focusout",
    () => {
      if (!keyboardViewportEnabled() || !editorSessionActive) {
        return;
      }

      // Focus can move between composer controls in the same event turn.
      // Check the settled active element before ending the keyboard session.
      window.requestAnimationFrame(() => {
        if (isEditableTarget(document.activeElement)) {
          return;
        }
        editorSessionActive = false;
        restoreAfterAnimation();
      });
    },
    true,
  );

  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", handleViewportChange);
  viewport?.addEventListener("scroll", handleViewportChange);
  window.addEventListener("resize", handleViewportChange);
}
