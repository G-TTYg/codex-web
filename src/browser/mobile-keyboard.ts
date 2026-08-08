/**
 * Stabilizes the browser app shell around software-keyboard transitions.
 *
 * The Desktop renderer sizes body and #root to 100vh. Software keyboards only
 * shrink the Visual Viewport on mobile WebKit, so the composer otherwise stays
 * at the bottom of the obscured Desktop-height shell. As soon as an editable
 * surface receives focus, pin the whole app shell to the Visual Viewport and
 * track WebKit's animation independently of keyboard-detection timing. On
 * close, normalize only the document root; renderer-owned conversation and
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
const KEYBOARD_ATTRIBUTE = "data-codex-software-keyboard";
const VIEWPORT_LOCK_ATTRIBUTE = "data-codex-visual-viewport-lock";
const KEYBOARD_HEIGHT_PROPERTY = "--codex-keyboard-viewport-height";
const KEYBOARD_LEFT_PROPERTY = "--codex-keyboard-viewport-left";
const KEYBOARD_TOP_PROPERTY = "--codex-keyboard-viewport-top";
const KEYBOARD_WIDTH_PROPERTY = "--codex-keyboard-viewport-width";
const KEYBOARD_HEIGHT_THRESHOLD_PX = 80;
const VIEWPORT_WIDTH_EPSILON_PX = 2;
const RESTORE_DELAY_MS = 160;
const VIEWPORT_ANIMATION_TRACK_MS = 1_200;

const KEYBOARD_VIEWPORT_STYLES = `
html[${VIEWPORT_LOCK_ATTRIBUTE}="true"] {
  overflow: hidden !important;
}

html[${VIEWPORT_LOCK_ATTRIBUTE}="true"] body {
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

html[${VIEWPORT_LOCK_ATTRIBUTE}="true"] #root {
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

function setVisualViewportBounds(viewport: ViewportSize): void {
  const root = document.documentElement;
  root.style.setProperty(KEYBOARD_HEIGHT_PROPERTY, `${viewport.height}px`);
  root.style.setProperty(KEYBOARD_LEFT_PROPERTY, `${viewport.left}px`);
  root.style.setProperty(KEYBOARD_TOP_PROPERTY, `${viewport.top}px`);
  root.style.setProperty(KEYBOARD_WIDTH_PROPERTY, `${viewport.width}px`);
}

function clearVisualViewportBounds(): void {
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
  let viewportLocked = false;
  let restoreTimer: number | null = null;
  let restoreGeneration = 0;
  let restoreInProgress = false;
  let viewportAnimationFrame: number | null = null;
  let viewportAnimationGeneration = 0;

  const setKeyboardOpen = (open: boolean): void => {
    document.documentElement.setAttribute(
      KEYBOARD_ATTRIBUTE,
      open ? "true" : "false",
    );
  };

  const setViewportLocked = (
    locked: boolean,
    viewport = viewportSize(),
  ): void => {
    viewportLocked = locked;
    if (locked) {
      // Write the initial bounds before enabling the selector so there is no
      // frame where the renderer's 100vh body is fixed with fallback sizes.
      setVisualViewportBounds(viewport);
      document.documentElement.setAttribute(VIEWPORT_LOCK_ATTRIBUTE, "true");
      return;
    }

    document.documentElement.setAttribute(VIEWPORT_LOCK_ATTRIBUTE, "false");
    clearVisualViewportBounds();
  };

  const stopViewportAnimationWatch = (): void => {
    viewportAnimationGeneration += 1;
    if (viewportAnimationFrame !== null) {
      window.cancelAnimationFrame(viewportAnimationFrame);
      viewportAnimationFrame = null;
    }
  };

  const cancelRestore = (): void => {
    // A timer may already have handed work to requestAnimationFrame. Advancing
    // the generation also invalidates those queued frames when a new input is
    // focused or the keyboard begins changing size again.
    restoreGeneration += 1;
    restoreInProgress = false;
    if (restoreTimer !== null) {
      window.clearTimeout(restoreTimer);
      restoreTimer = null;
    }
  };

  const restoreAfterAnimation = (): void => {
    // A plain focus transition must never move the page. Root normalization is
    // only valid after this session actually observed keyboard occlusion.
    if (!keyboardWasOpen || restoreInProgress) {
      return;
    }

    cancelRestore();
    restoreInProgress = true;
    const generation = restoreGeneration;
    restoreTimer = window.setTimeout(() => {
      restoreTimer = null;
      if (generation !== restoreGeneration || !keyboardWasOpen) {
        if (generation === restoreGeneration) {
          restoreInProgress = false;
        }
        return;
      }

      const current = viewportSize();
      if (
        current.height - minimumSessionHeight <
        KEYBOARD_HEIGHT_THRESHOLD_PX
      ) {
        // The close animation has not expanded far enough yet. Release this
        // attempt and let the next viewport sample schedule a fresh one.
        restoreInProgress = false;
        return;
      }

      // Two frames let the final Visual Viewport resize update the layout
      // before clearing Safari's residual root offset. Each frame rechecks the
      // generation so a newly focused editor cannot be moved by stale work.
      window.requestAnimationFrame(() => {
        if (generation !== restoreGeneration || !keyboardWasOpen) {
          if (generation === restoreGeneration) {
            restoreInProgress = false;
          }
          return;
        }
        window.requestAnimationFrame(() => {
          if (generation !== restoreGeneration || !keyboardWasOpen) {
            if (generation === restoreGeneration) {
              restoreInProgress = false;
            }
            return;
          }
          restoreInProgress = false;
          keyboardWasOpen = false;
          setKeyboardOpen(false);
          editorSessionActive = isEditableTarget(document.activeElement);
          if (editorSessionActive) {
            // iOS can dismiss its keyboard without blurring the editor. Keep
            // the viewport contract armed so reopening the keyboard does not
            // depend on another focus event.
            setViewportLocked(true);
          } else {
            stopViewportAnimationWatch();
            setViewportLocked(false);
          }
          resetRootScroll();
          baseline = viewportSize();
          minimumSessionHeight = baseline.height;
        });
      });
    }, RESTORE_DELAY_MS);
  };

  function handleViewportChange(): void {
    if (!keyboardViewportEnabled()) {
      if (viewportLocked) {
        stopViewportAnimationWatch();
        setViewportLocked(false);
      }
      return;
    }

    const current = viewportSize();
    if (viewportLocked) {
      setVisualViewportBounds(current);
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
      if (viewportLocked) {
        stopViewportAnimationWatch();
        setViewportLocked(false);
      }
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
      // Keep the shell pinned until WebKit has finished expanding the Visual
      // Viewport. Removing the constraint during the close animation exposes
      // the renderer's 100vh shell and causes the same disappearing jump.
      restoreAfterAnimation();
    }
  }

  const startViewportAnimationWatch = (): void => {
    stopViewportAnimationWatch();
    const generation = viewportAnimationGeneration;
    const deadline = performance.now() + VIEWPORT_ANIMATION_TRACK_MS;

    const trackFrame = (): void => {
      viewportAnimationFrame = null;
      if (generation !== viewportAnimationGeneration || !viewportLocked) {
        return;
      }

      // Some WebKit releases coalesce Visual Viewport events until late in the
      // keyboard animation. Sampling during the bounded transition window
      // keeps the app shell aligned even when no resize/scroll event arrives.
      handleViewportChange();
      if (performance.now() < deadline) {
        viewportAnimationFrame = window.requestAnimationFrame(trackFrame);
      }
    };

    viewportAnimationFrame = window.requestAnimationFrame(trackFrame);
  };

  window.addEventListener(
    "focusin",
    (event) => {
      if (!keyboardViewportEnabled() || !isEditableTarget(event.target)) {
        return;
      }

      cancelRestore();
      editorSessionActive = true;
      const current = viewportSize();
      // Visibility is focus-driven, not threshold-driven. A hardware keyboard
      // leaves these bounds equal to the normal viewport, while a software
      // keyboard can now shrink them from its very first animation step.
      setViewportLocked(true, current);
      if (!keyboardWasOpen) {
        // Keep the last no-editor height as the keyboard baseline. WebKit may
        // dispatch focusin after the first Visual Viewport animation step; if
        // that already-shortened height became the baseline, the remaining
        // animation could stay below the detection threshold forever.
        minimumSessionHeight = Math.min(baseline.height, current.height);
        handleViewportChange();
      }
      startViewportAnimationWatch();
    },
    true,
  );

  window.addEventListener(
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
        if (keyboardWasOpen) {
          restoreAfterAnimation();
          return;
        }

        stopViewportAnimationWatch();
        setViewportLocked(false);
        baseline = viewportSize();
        minimumSessionHeight = baseline.height;
      });
    },
    true,
  );

  const handleViewportEvent = (): void => {
    handleViewportChange();
    if (viewportLocked) {
      startViewportAnimationWatch();
    }
  };

  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", handleViewportEvent);
  viewport?.addEventListener("scroll", handleViewportEvent);
  window.addEventListener("resize", handleViewportEvent);
}
