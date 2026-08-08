/**
 * Keeps focused renderer regions usable across software-keyboard transitions.
 *
 * The Desktop renderer keeps a 100vh shell on mobile WebKit. Moving or sizing
 * that complete shell also moves unrelated headers and sidebars. This module
 * instead assigns each editable to a semantic owner: the AI composer lifts the
 * center content region to the keyboard edge, other regional editors move only
 * when their input would be occluded, and top search surfaces stay native.
 */

import {
  hasTouchInputCapability,
  MOBILE_SEARCH_INPUT_SELECTOR,
} from "./mobile-layout";

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
const KEYBOARD_SESSION_ATTRIBUTE = "data-codex-keyboard-session";
const ACTIVE_SURFACE_ATTRIBUTE = "data-codex-active-keyboard-surface";
const ACTIVE_REGION_ATTRIBUTE = "data-codex-keyboard-region";
const REGION_SHIFT_PROPERTY = "--codex-keyboard-region-shift";
const KEYBOARD_HEIGHT_THRESHOLD_PX = 80;
const VIEWPORT_WIDTH_EPSILON_PX = 2;
const RESTORE_DELAY_MS = 160;
const VIEWPORT_ANIMATION_TRACK_MS = 1_200;
const COMPOSER_SELECTOR = '[data-codex-keyboard-surface="composer"]';
const FILE_TREE_SEARCH_SELECTOR = "[data-file-tree-search-input]";
const TEXT_FILE_SEARCH_SELECTOR = "input[data-search]";
const COMMAND_SEARCH_SELECTOR = '[cmdk-input], [role="searchbox"]';
const MAIN_CONTENT_REGION_SELECTOR = "[data-app-shell-main-content-layout]";
const LEFT_PANEL_SELECTOR = "aside.app-shell-left-panel";
const RIGHT_PANEL_SELECTOR = 'aside[data-app-shell-focus-area="right-panel"]';

const KEYBOARD_REGION_STYLES = `
[${ACTIVE_REGION_ATTRIBUTE}="active"] {
  translate: 0 var(${REGION_SHIFT_PROPERTY}, 0px) !important;
  will-change: translate;
}
`;

let installed = false;

type ViewportSize = {
  height: number;
  layoutWidth: number;
  top: number;
};

type KeyboardMovement = "align-region-bottom" | "ensure-visible" | "native";

type KeyboardSurfaceName =
  | "composer"
  | "file-tree-search"
  | "command-search"
  | "text-file-search"
  | "dialog-editor"
  | "left-sidebar-editor"
  | "right-sidebar-editor"
  | "main-editor"
  | "editor";

type KeyboardSurface = {
  editable: HTMLElement;
  movement: KeyboardMovement;
  name: KeyboardSurfaceName;
  region: HTMLElement | null;
};

function viewportSize(): ViewportSize {
  const viewport = window.visualViewport;
  return {
    height: viewport?.height ?? window.innerHeight,
    // Visual Viewport width can jitter while keyboard accessory UI animates.
    // Layout width changes only for a real rotation or Split View resize.
    layoutWidth: window.innerWidth,
    top: viewport?.offsetTop ?? 0,
  };
}

function installKeyboardRegionStyles(): void {
  if (document.querySelector("style[data-codex-mobile-keyboard]")) {
    return;
  }

  const style = document.createElement("style");
  style.dataset.codexMobileKeyboard = "true";
  style.textContent = KEYBOARD_REGION_STYLES;
  (document.head ?? document.documentElement).append(style);
}

function closestHTMLElement(
  element: Element,
  selector: string,
): HTMLElement | null {
  const match = element.closest(selector);
  return match instanceof HTMLElement ? match : null;
}

function editableTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }

  const editable = target.closest(EDITABLE_SELECTOR);
  if (!(editable instanceof HTMLElement)) {
    return null;
  }

  if (
    (editable instanceof HTMLInputElement ||
      editable instanceof HTMLTextAreaElement) &&
    (editable.disabled || editable.readOnly)
  ) {
    return null;
  }
  return editable;
}

function regionalSurface(
  editable: HTMLElement,
  selector: string,
  name: KeyboardSurfaceName,
): KeyboardSurface | null {
  const region = closestHTMLElement(editable, selector);
  return region === null
    ? null
    : { editable, movement: "ensure-visible", name, region };
}

function keyboardSurface(target: EventTarget | null): KeyboardSurface | null {
  const editable = editableTarget(target);
  if (editable === null) {
    return null;
  }

  // These are renderer-owned semantic contracts. They intentionally avoid
  // localized placeholders and fingerprinted utility classes.
  if (editable.closest(COMPOSER_SELECTOR)) {
    const region = closestHTMLElement(editable, MAIN_CONTENT_REGION_SELECTOR);
    return {
      editable,
      movement: region === null ? "native" : "align-region-bottom",
      name: "composer",
      region,
    };
  }
  if (editable.matches(FILE_TREE_SEARCH_SELECTOR)) {
    return {
      editable,
      movement: "native",
      name: "file-tree-search",
      region: null,
    };
  }
  if (editable.matches(TEXT_FILE_SEARCH_SELECTOR)) {
    return (
      regionalSurface(
        editable,
        MAIN_CONTENT_REGION_SELECTOR,
        "text-file-search",
      ) ?? {
        editable,
        movement: "native",
        name: "text-file-search",
        region: null,
      }
    );
  }
  if (editable.matches(COMMAND_SEARCH_SELECTOR)) {
    return {
      editable,
      movement: "native",
      name: "command-search",
      region: null,
    };
  }

  const ownedSurface =
    regionalSurface(editable, '[role="dialog"]', "dialog-editor") ??
    regionalSurface(editable, LEFT_PANEL_SELECTOR, "left-sidebar-editor") ??
    regionalSurface(editable, RIGHT_PANEL_SELECTOR, "right-sidebar-editor") ??
    regionalSurface(editable, MAIN_CONTENT_REGION_SELECTOR, "main-editor");
  if (ownedSurface !== null) {
    return ownedSurface;
  }

  return {
    editable,
    movement: "native",
    name: editable.matches(MOBILE_SEARCH_INPUT_SELECTOR)
      ? "command-search"
      : "editor",
    region: null,
  };
}

function keyboardViewportEnabled(): boolean {
  // Geometry follows device capability rather than the last pointer. An iPad
  // trackpad or hybrid-laptop mouse can still focus an editor whose software
  // keyboard opens immediately afterward.
  return hasTouchInputCapability();
}

function calculateRegionShift(
  surface: KeyboardSurface,
  viewport: ViewportSize,
  currentShift: number,
): number {
  if (surface.region === null || surface.movement === "native") {
    return 0;
  }

  const visibleBottom = viewport.top + viewport.height;
  if (surface.movement === "align-region-bottom") {
    const regionBottom =
      surface.region.getBoundingClientRect().bottom - currentShift;
    return Math.min(0, visibleBottom - regionBottom);
  }

  // getBoundingClientRect includes the active region translation. Remove the
  // previous shift before calculating the next frame so viewport events do not
  // compound motion. Regional editors move only if the input itself is hidden.
  const rect = surface.editable.getBoundingClientRect();
  const unshiftedTop = rect.top - currentShift;
  const unshiftedBottom = rect.bottom - currentShift;
  if (unshiftedBottom <= visibleBottom) {
    return 0;
  }

  let shift = visibleBottom - unshiftedBottom;
  const editableHeight = unshiftedBottom - unshiftedTop;
  if (editableHeight <= viewport.height) {
    shift = Math.max(shift, viewport.top - unshiftedTop);
  }
  return Math.min(0, shift);
}

function resetRootScroll(): void {
  // This clears WebKit's residual Layout Viewport pan only after a confirmed
  // keyboard close. Nested renderer scrollers deliberately remain untouched.
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
  installKeyboardRegionStyles();

  let baseline = viewportSize();
  let minimumSessionHeight = baseline.height;
  let keyboardWasOpen = false;
  let editorSessionActive = false;
  let activeKeyboardSurface: KeyboardSurface | null = null;
  let activeRegionShift = 0;
  let keyboardSessionArmed = false;
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

  const clearRegion = (region: HTMLElement | null): void => {
    region?.removeAttribute(ACTIVE_REGION_ATTRIBUTE);
    region?.style.removeProperty(REGION_SHIFT_PROPERTY);
  };

  const applyActiveRegion = (viewport: ViewportSize): void => {
    const surface = activeKeyboardSurface;
    if (surface === null || surface.region === null) {
      activeRegionShift = 0;
      return;
    }

    const nextShift = calculateRegionShift(
      surface,
      viewport,
      activeRegionShift,
    );
    surface.region.setAttribute(ACTIVE_REGION_ATTRIBUTE, "active");
    surface.region.style.setProperty(REGION_SHIFT_PROPERTY, `${nextShift}px`);
    activeRegionShift = nextShift;
  };

  const setActiveKeyboardSurface = (
    surface: KeyboardSurface | null,
    viewport?: ViewportSize,
  ): void => {
    const previousRegion = activeKeyboardSurface?.region ?? null;
    const nextRegion = surface?.region ?? null;
    if (previousRegion !== nextRegion) {
      clearRegion(previousRegion);
      activeRegionShift = 0;
    }

    activeKeyboardSurface = surface;
    document.documentElement.setAttribute(
      ACTIVE_SURFACE_ATTRIBUTE,
      surface?.name ?? "none",
    );
    if (keyboardSessionArmed && viewport !== undefined) {
      applyActiveRegion(viewport);
    }
  };

  const setKeyboardSessionArmed = (
    armed: boolean,
    viewport = viewportSize(),
  ): void => {
    keyboardSessionArmed = armed;
    document.documentElement.setAttribute(
      KEYBOARD_SESSION_ATTRIBUTE,
      armed ? "true" : "false",
    );
    if (armed) {
      applyActiveRegion(viewport);
      return;
    }

    clearRegion(activeKeyboardSurface?.region ?? null);
    activeRegionShift = 0;
  };

  setKeyboardOpen(false);
  setKeyboardSessionArmed(false);
  setActiveKeyboardSurface(null);

  const stopViewportAnimationWatch = (): void => {
    viewportAnimationGeneration += 1;
    if (viewportAnimationFrame !== null) {
      window.cancelAnimationFrame(viewportAnimationFrame);
      viewportAnimationFrame = null;
    }
  };

  const cancelRestore = (): void => {
    // A timer may already have handed work to requestAnimationFrame. Advancing
    // the generation invalidates those queued frames when focus changes.
    restoreGeneration += 1;
    restoreInProgress = false;
    if (restoreTimer !== null) {
      window.clearTimeout(restoreTimer);
      restoreTimer = null;
    }
  };

  const restoreAfterAnimation = (): void => {
    // A plain hardware-keyboard focus must never normalize document scroll.
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
        restoreInProgress = false;
        return;
      }

      // Two frames allow WebKit's final Visual Viewport resize to settle before
      // clearing its residual root pan. Every frame rechecks the generation.
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
          baseline = viewportSize();
          minimumSessionHeight = baseline.height;
          const surface = keyboardSurface(document.activeElement);
          editorSessionActive = surface !== null;
          setActiveKeyboardSurface(surface);
          if (editorSessionActive) {
            // iOS may dismiss its keyboard without blurring. Keep the semantic
            // region armed at zero shift so a reopen needs no new focus event.
            setKeyboardSessionArmed(true, baseline);
          } else {
            stopViewportAnimationWatch();
            setKeyboardSessionArmed(false);
            setActiveKeyboardSurface(null);
          }
          resetRootScroll();
        });
      });
    }, RESTORE_DELAY_MS);
  };

  function handleViewportChange(): void {
    if (!keyboardViewportEnabled()) {
      if (keyboardSessionArmed) {
        stopViewportAnimationWatch();
        setKeyboardSessionArmed(false);
      }
      setActiveKeyboardSurface(null);
      return;
    }

    const current = viewportSize();
    if (
      Math.abs(current.layoutWidth - baseline.layoutWidth) >
      VIEWPORT_WIDTH_EPSILON_PX
    ) {
      // Rotation and Split View establish a new baseline rather than keyboard
      // occlusion. A still-open session continues from that new geometry.
      cancelRestore();
      baseline = current;
      minimumSessionHeight = current.height;
      if (keyboardWasOpen) {
        if (keyboardSessionArmed) {
          applyActiveRegion(current);
        }
        return;
      }
    }

    if (keyboardSessionArmed) {
      applyActiveRegion(current);
    }

    if (!editorSessionActive && !keyboardWasOpen) {
      baseline = current;
      minimumSessionHeight = current.height;
      if (keyboardSessionArmed) {
        stopViewportAnimationWatch();
        setKeyboardSessionArmed(false);
      }
      setActiveKeyboardSurface(null);
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
      // The active region continues following viewport frames until WebKit has
      // finished expanding; cleanup then removes only its semantic marker.
      restoreAfterAnimation();
    }
  }

  const startViewportAnimationWatch = (): void => {
    stopViewportAnimationWatch();
    const generation = viewportAnimationGeneration;
    const deadline = performance.now() + VIEWPORT_ANIMATION_TRACK_MS;

    const trackFrame = (): void => {
      viewportAnimationFrame = null;
      if (generation !== viewportAnimationGeneration || !keyboardSessionArmed) {
        return;
      }

      // Some WebKit releases coalesce resize/scroll events until late in the
      // keyboard animation. Bounded frame sampling keeps only the active region
      // synchronized without touching the complete app shell.
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
      const surface = keyboardSurface(event.target);
      if (!keyboardViewportEnabled() || surface === null) {
        return;
      }

      cancelRestore();
      editorSessionActive = true;
      const current = viewportSize();
      setActiveKeyboardSurface(surface);
      // Arm from the first animation frame; waiting for the keyboard threshold
      // creates the exact gap where a bottom composer disappears.
      setKeyboardSessionArmed(true, current);
      if (!keyboardWasOpen) {
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

      // A settled focus can move between semantic regions in the same turn.
      window.requestAnimationFrame(() => {
        const surface = keyboardSurface(document.activeElement);
        if (surface !== null) {
          setActiveKeyboardSurface(surface, viewportSize());
          return;
        }
        editorSessionActive = false;
        if (keyboardWasOpen) {
          restoreAfterAnimation();
          return;
        }

        stopViewportAnimationWatch();
        setKeyboardSessionArmed(false);
        setActiveKeyboardSurface(null);
        baseline = viewportSize();
        minimumSessionHeight = baseline.height;
      });
    },
    true,
  );

  const handleViewportEvent = (): void => {
    handleViewportChange();
    if (keyboardSessionArmed) {
      startViewportAnimationWatch();
    }
  };

  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", handleViewportEvent);
  viewport?.addEventListener("scroll", handleViewportEvent);
  window.addEventListener("resize", handleViewportEvent);
}
