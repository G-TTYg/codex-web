/**
 * Keeps focused renderer regions usable across software-keyboard transitions.
 *
 * The Desktop renderer keeps a 100vh shell on mobile WebKit. This coordinator
 * waits until Visual Viewport geometry has settled, then commits at most one
 * owner-scoped correction for the complete keyboard session. It never mutates
 * the focused editing host, follows animation frames, or writes document scroll
 * state; all three can feed WebKit's native focus pan back into its keyplane.
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
const VIEWPORT_SETTLE_DELAY_MS = 240;
const COMPOSER_SELECTOR = '[data-codex-keyboard-surface="composer"]';
const PROJECT_SEARCH_SELECTOR =
  '[data-codex-keyboard-surface="project-search"]';
const FILE_TREE_SEARCH_SELECTOR = "[data-file-tree-search-input]";
const TEXT_FILE_SEARCH_SELECTOR = "input[data-search]";
const COMMAND_SEARCH_SELECTOR = '[cmdk-input], [role="searchbox"]';
const PROJECT_POPOVER_REGION_SELECTOR =
  '[role="dialog"], [data-radix-popper-content-wrapper]';
const MAIN_CONTENT_REGION_SELECTOR = "[data-app-shell-main-content-layout]";
const LEFT_PANEL_SELECTOR = "aside.app-shell-left-panel";
const RIGHT_PANEL_SELECTOR = 'aside[data-app-shell-focus-area="right-panel"]';

const KEYBOARD_REGION_STYLES = `
[${ACTIVE_REGION_ATTRIBUTE}="active"] {
  translate: 0 var(${REGION_SHIFT_PROPERTY}, 0px) !important;
  transition: none !important;
}
`;

let installed = false;

type ViewportSize = {
  height: number;
  layoutWidth: number;
  top: number;
};

type KeyboardMovement =
  | "align-region-bottom"
  | "ensure-region-visible"
  | "ensure-visible"
  | "native";

type KeyboardSurfaceName =
  | "composer"
  | "project-search"
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
  if (editable.closest(PROJECT_SEARCH_SELECTOR)) {
    const region = closestHTMLElement(
      editable,
      PROJECT_POPOVER_REGION_SELECTOR,
    );
    return {
      editable,
      movement: region === null ? "native" : "ensure-region-visible",
      name: "project-search",
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
): number {
  if (surface.region === null || surface.movement === "native") {
    return 0;
  }

  const visibleBottom = viewport.top + viewport.height;
  if (surface.movement === "align-region-bottom") {
    const regionBottom = surface.region.getBoundingClientRect().bottom;
    return Math.min(0, visibleBottom - regionBottom);
  }

  // The previous owner correction is cleared before this function is called,
  // so this rectangle is always the renderer's unshifted geometry.
  const rect = (
    surface.movement === "ensure-region-visible"
      ? surface.region
      : surface.editable
  ).getBoundingClientRect();
  if (rect.bottom <= visibleBottom) {
    return 0;
  }

  let shift = visibleBottom - rect.bottom;
  const editableHeight = rect.bottom - rect.top;
  if (editableHeight <= viewport.height) {
    shift = Math.max(shift, viewport.top - rect.top);
  }
  return Math.min(0, shift);
}

export function installMobileKeyboardViewport(): void {
  if (installed) {
    return;
  }
  installed = true;
  installKeyboardRegionStyles();

  let baseline = viewportSize();
  let minimumSessionHeight = baseline.height;
  let keyboardOpen = false;
  let editorSessionActive = false;
  let activeKeyboardSurface: KeyboardSurface | null = null;
  let appliedRegion: HTMLElement | null = null;
  let surfaceVersion = 0;
  let appliedSurfaceVersion = -1;
  let settleTimer: number | null = null;
  let settleGeneration = 0;
  let rotatedWhileKeyboardOpen = false;

  const setKeyboardOpen = (open: boolean): void => {
    document.documentElement.setAttribute(
      KEYBOARD_ATTRIBUTE,
      open ? "true" : "false",
    );
  };

  const setKeyboardSessionActive = (active: boolean): void => {
    document.documentElement.setAttribute(
      KEYBOARD_SESSION_ATTRIBUTE,
      active ? "true" : "false",
    );
  };

  const clearRegion = (region: HTMLElement | null): void => {
    region?.removeAttribute(ACTIVE_REGION_ATTRIBUTE);
    region?.style.removeProperty(REGION_SHIFT_PROPERTY);
  };

  const clearAppliedRegion = (): void => {
    clearRegion(appliedRegion);
    appliedRegion = null;
    appliedSurfaceVersion = -1;
  };

  const sameSurface = (
    left: KeyboardSurface | null,
    right: KeyboardSurface | null,
  ): boolean => {
    if (left === null || right === null) {
      return left === right;
    }
    return (
      left.editable === right.editable &&
      left.movement === right.movement &&
      left.name === right.name &&
      left.region === right.region
    );
  };

  const setActiveKeyboardSurface = (surface: KeyboardSurface | null): void => {
    if (!sameSurface(activeKeyboardSurface, surface)) {
      surfaceVersion += 1;
    }
    activeKeyboardSurface = surface;
    document.documentElement.setAttribute(
      ACTIVE_SURFACE_ATTRIBUTE,
      surface?.name ?? "none",
    );
  };

  const commitActiveSurface = (viewport: ViewportSize): void => {
    if (appliedSurfaceVersion === surfaceVersion) {
      return;
    }

    clearAppliedRegion();
    const surface = activeKeyboardSurface;
    appliedSurfaceVersion = surfaceVersion;
    if (surface === null || surface.region === null) {
      return;
    }

    const shift = calculateRegionShift(surface, viewport);
    surface.region.setAttribute(ACTIVE_REGION_ATTRIBUTE, "active");
    surface.region.style.setProperty(REGION_SHIFT_PROPERTY, `${shift}px`);
    appliedRegion = surface.region;
  };

  setKeyboardOpen(false);
  setKeyboardSessionActive(false);
  setActiveKeyboardSurface(null);

  const cancelSettle = (): void => {
    settleGeneration += 1;
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  const resetInactiveCoordinator = (current = viewportSize()): void => {
    cancelSettle();
    clearAppliedRegion();
    keyboardOpen = false;
    rotatedWhileKeyboardOpen = false;
    editorSessionActive = false;
    baseline = current;
    minimumSessionHeight = current.height;
    setKeyboardOpen(false);
    setKeyboardSessionActive(false);
    setActiveKeyboardSurface(null);
  };

  const settleViewport = (): void => {
    if (!keyboardViewportEnabled()) {
      resetInactiveCoordinator();
      return;
    }

    const current = viewportSize();
    if (
      Math.abs(current.layoutWidth - baseline.layoutWidth) >
      VIEWPORT_WIDTH_EPSILON_PX
    ) {
      // When rotation happens with no keyboard, the new viewport is a complete
      // baseline. During an open keyboard session the closed height is unknown;
      // preserve open state and re-baseline only after the viewport expands.
      baseline = keyboardOpen
        ? { ...baseline, layoutWidth: current.layoutWidth }
        : current;
      minimumSessionHeight = current.height;
      if (keyboardOpen) {
        rotatedWhileKeyboardOpen = true;
        surfaceVersion += 1;
      }
    }

    minimumSessionHeight = Math.min(minimumSessionHeight, current.height);
    const keyboardOccluded =
      baseline.height - current.height >= KEYBOARD_HEIGHT_THRESHOLD_PX;
    const keyboardRecovered =
      keyboardOpen &&
      (!keyboardOccluded ||
        (rotatedWhileKeyboardOpen &&
          current.height - minimumSessionHeight >=
            KEYBOARD_HEIGHT_THRESHOLD_PX));

    if (editorSessionActive && keyboardOccluded && !keyboardRecovered) {
      keyboardOpen = true;
      setKeyboardOpen(true);
      setKeyboardSessionActive(true);
      commitActiveSurface(current);
      return;
    }

    if (keyboardRecovered) {
      keyboardOpen = false;
      rotatedWhileKeyboardOpen = false;
      clearAppliedRegion();
      setKeyboardOpen(false);
      baseline = current;
      minimumSessionHeight = current.height;
      if (!editorSessionActive) {
        setActiveKeyboardSurface(null);
        setKeyboardSessionActive(false);
      }
      return;
    }

    if (!keyboardOpen) {
      clearAppliedRegion();
      setKeyboardOpen(false);
      if (baseline.height - current.height < KEYBOARD_HEIGHT_THRESHOLD_PX) {
        baseline = current;
        minimumSessionHeight = current.height;
      }
      if (!editorSessionActive) {
        setActiveKeyboardSurface(null);
        setKeyboardSessionActive(false);
      }
    }
  };

  const scheduleViewportSettle = (): void => {
    cancelSettle();
    const generation = settleGeneration;
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      if (generation !== settleGeneration) {
        return;
      }
      settleViewport();
    }, VIEWPORT_SETTLE_DELAY_MS);
  };

  window.addEventListener(
    "focusin",
    (event) => {
      const surface = keyboardSurface(event.target);
      if (!keyboardViewportEnabled() || surface === null) {
        return;
      }

      editorSessionActive = true;
      setActiveKeyboardSurface(surface);
      setKeyboardSessionActive(true);
      minimumSessionHeight = Math.min(
        minimumSessionHeight,
        viewportSize().height,
      );
      scheduleViewportSettle();
    },
    true,
  );

  window.addEventListener(
    "focusout",
    () => {
      if (!keyboardViewportEnabled() || !editorSessionActive) {
        return;
      }

      // Focusout precedes focusin when moving between editors. Wait only for
      // that event turn; no layout frame is sampled or changed here.
      queueMicrotask(() => {
        const surface = keyboardSurface(document.activeElement);
        if (surface !== null) {
          editorSessionActive = true;
          setActiveKeyboardSurface(surface);
          setKeyboardSessionActive(true);
          scheduleViewportSettle();
          return;
        }
        editorSessionActive = false;
        if (keyboardOpen) {
          scheduleViewportSettle();
          return;
        }

        cancelSettle();
        clearAppliedRegion();
        setKeyboardSessionActive(false);
        setActiveKeyboardSurface(null);
        baseline = viewportSize();
        minimumSessionHeight = baseline.height;
      });
    },
    true,
  );

  const handleViewportEvent = (): void => {
    const current = viewportSize();
    minimumSessionHeight = Math.min(minimumSessionHeight, current.height);
    scheduleViewportSettle();
  };

  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", handleViewportEvent);
  viewport?.addEventListener("scroll", handleViewportEvent);
  window.addEventListener("resize", handleViewportEvent);
}
