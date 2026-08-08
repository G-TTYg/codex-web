/**
 * Stabilizes the browser app shell around software-keyboard transitions.
 *
 * Mobile WebKit can keep the layout viewport scrolled after its visual
 * viewport expands again, even when the focused composer remains mounted.
 * Only the document root is normalized here; renderer-owned conversation and
 * editor scrollers retain their positions.
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
const TOUCH_INPUT_ATTRIBUTE = "data-codex-touch-input";
const KEYBOARD_ATTRIBUTE = "data-codex-software-keyboard";
const KEYBOARD_HEIGHT_THRESHOLD_PX = 80;
const VIEWPORT_WIDTH_EPSILON_PX = 2;
const RESTORE_DELAY_MS = 160;

let installed = false;

type ViewportSize = {
  height: number;
  width: number;
};

function viewportSize(): ViewportSize {
  const viewport = window.visualViewport;
  return {
    height: viewport?.height ?? window.innerHeight,
    width: viewport?.width ?? window.innerWidth,
  };
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

function touchKeyboardEnabled(): boolean {
  return (
    hasTouchInputCapability() &&
    document.documentElement.getAttribute(TOUCH_INPUT_ATTRIBUTE) === "true"
  );
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
          resetRootScroll();
          keyboardWasOpen = false;
          setKeyboardOpen(false);
          baseline = viewportSize();
          minimumSessionHeight = baseline.height;
          editorSessionActive = isEditableTarget(document.activeElement);
        });
      });
    }, RESTORE_DELAY_MS);
  };

  const handleViewportChange = (): void => {
    if (!touchKeyboardEnabled()) {
      return;
    }

    const current = viewportSize();
    if (Math.abs(current.width - baseline.width) > VIEWPORT_WIDTH_EPSILON_PX) {
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
      setKeyboardOpen(true);
      return;
    }

    if (
      keyboardWasOpen &&
      current.height - minimumSessionHeight >= KEYBOARD_HEIGHT_THRESHOLD_PX
    ) {
      setKeyboardOpen(false);
      restoreAfterAnimation();
    }
  };

  document.addEventListener(
    "focusin",
    (event) => {
      if (!touchKeyboardEnabled() || !isEditableTarget(event.target)) {
        return;
      }

      cancelRestore();
      editorSessionActive = true;
      const current = viewportSize();
      if (!keyboardWasOpen) {
        baseline = current;
        minimumSessionHeight = current.height;
      }
    },
    true,
  );

  document.addEventListener(
    "focusout",
    () => {
      if (!touchKeyboardEnabled() || !editorSessionActive) {
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
