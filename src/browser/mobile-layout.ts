/**
 * Owns touch-capable and narrow-viewport layout behavior that the Desktop
 * renderer does not provide. Keep selectors semantic: the renderer's
 * fingerprinted classes change between Desktop releases, while app-shell data
 * attributes do not.
 */

export const NARROW_VIEWPORT_QUERY = "(max-width: 768px)";
export const TOUCH_LAYOUT_VIEWPORT_QUERY = "(max-width: 1366px)";
export const TOUCH_CAPABILITY_QUERY =
  "(any-pointer: coarse), (pointer: coarse), (hover: none)";

const MOBILE_LAYOUT_ATTRIBUTE = "data-codex-mobile-layout";
const MOBILE_UI_ATTRIBUTE = "data-codex-mobile-ui";
const MOBILE_LAYOUT_SELECTOR = `html[${MOBILE_LAYOUT_ATTRIBUTE}="true"]`;

const MOBILE_LAYOUT_STYLES = `
${MOBILE_LAYOUT_SELECTOR},
${MOBILE_LAYOUT_SELECTOR} body {
  max-width: 100%;
  overflow-x: hidden !important;
  overflow-x: clip !important;
  overscroll-behavior-x: none;
}

${MOBILE_LAYOUT_SELECTOR} aside.app-shell-left-panel {
  position: absolute !important;
  inset: 0 auto 0 0;
  z-index: 40;
  isolation: isolate;
  background:
    linear-gradient(
      var(--color-background-surface-under, Canvas),
      var(--color-background-surface-under, Canvas)
    ),
    Canvas;
  box-shadow: 12px 0 28px rgb(0 0 0 / 28%);
}

${MOBILE_LAYOUT_SELECTOR} aside.app-shell-left-panel[style*="width: 0px"] {
  pointer-events: none !important;
  box-shadow: none;
}

${MOBILE_LAYOUT_SELECTOR} aside[data-app-shell-focus-area="right-panel"] {
  position: absolute !important;
  inset: 0 0 0 auto;
  z-index: 41;
  max-width: min(86vw, 600px);
  overflow: hidden !important;
  isolation: isolate;
  overscroll-behavior: contain;
  background:
    linear-gradient(
      var(--color-background-surface, Canvas),
      var(--color-background-surface, Canvas)
    ),
    Canvas;
  box-shadow: -12px 0 28px rgb(0 0 0 / 28%);
}

${MOBILE_LAYOUT_SELECTOR}
  aside[data-app-shell-focus-area="right-panel"][data-codex-panel-open="false"] {
  pointer-events: none !important;
  box-shadow: none;
}

/* The renderer keeps the panel's persisted Desktop width on its inner motion
   surface. Clamp that surface to the drawer so it cannot widen the document
   and leave mobile Safari horizontally offset after the close animation. */
${MOBILE_LAYOUT_SELECTOR}
  [data-codex-right-panel-surface] {
  inset-inline: 0 !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
}

/* A resize handle has no useful meaning on an overlay drawer and its
   pointer-capturing touch-none surface conflicts with native panning. */
${MOBILE_LAYOUT_SELECTOR}
  aside[data-app-shell-focus-area="right-panel"]
  > [role="separator"] {
  display: none !important;
}

${MOBILE_LAYOUT_SELECTOR} main[data-app-shell-main-surface] {
  flex-basis: 100% !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
}

/* Upstream full-width panel mode collapses this viewport to width: 0. A
   drawer is always an overlay, so the underlying page must remain full-size. */
${MOBILE_LAYOUT_SELECTOR}
  [data-app-shell-main-content-layout][data-app-shell-right-panel-full-width] {
  flex: 1 1 100% !important;
  min-width: 0 !important;
  overflow: hidden !important;
  width: 100% !important;
}
`;

let installed = false;

const LEFT_PANEL_SELECTOR = "aside.app-shell-left-panel";
const RIGHT_PANEL_SELECTOR = 'aside[data-app-shell-focus-area="right-panel"]';
const PERSISTENT_MOBILE_SEARCH_SELECTOR =
  '[data-file-tree-search-input], [cmdk-input], [role="searchbox"], input[type="search"]';

export function hasTouchInputCapability(): boolean {
  return (
    navigator.maxTouchPoints > 0 || matchMedia(TOUCH_CAPABILITY_QUERY).matches
  );
}

export function shouldUseMobileLayout(): boolean {
  return (
    matchMedia(NARROW_VIEWPORT_QUERY).matches ||
    (hasTouchInputCapability() &&
      matchMedia(TOUCH_LAYOUT_VIEWPORT_QUERY).matches)
  );
}

export function shouldUseMobileUI(): boolean {
  return shouldUseMobileLayout() || hasTouchInputCapability();
}

function setBooleanAttribute(name: string, enabled: boolean): void {
  document.documentElement.setAttribute(name, enabled ? "true" : "false");
}

function updateMobileLayoutMode(): void {
  setBooleanAttribute(MOBILE_LAYOUT_ATTRIBUTE, shouldUseMobileLayout());
  setBooleanAttribute(MOBILE_UI_ATTRIBUTE, shouldUseMobileUI());
}

function installMobileLayoutStyles(): void {
  if (document.querySelector("style[data-codex-mobile-layout]")) {
    return;
  }

  const style = document.createElement("style");
  style.dataset.codexMobileLayout = "true";
  style.textContent = MOBILE_LAYOUT_STYLES;
  (document.head ?? document.documentElement).append(style);
}

export function installMobileLayout(
  closeLeftSidebar: () => void,
  closeRightPanel: () => void,
): void {
  if (installed) {
    return;
  }
  installed = true;

  // Set capability attributes before the renderer mounts so iPadOS does not
  // briefly bootstrap the Desktop sidebar state and then reflow into drawers.
  updateMobileLayoutMode();
  installMobileLayoutStyles();

  const layoutQueries = [
    matchMedia(NARROW_VIEWPORT_QUERY),
    matchMedia(TOUCH_LAYOUT_VIEWPORT_QUERY),
    matchMedia(TOUCH_CAPABILITY_QUERY),
  ];
  for (const query of layoutQueries) {
    query.addEventListener("change", updateMobileLayoutMode);
  }

  const retainMobileSearch = (event: FocusEvent): void => {
    if (!shouldUseMobileUI()) {
      return;
    }

    const target = event.target;
    if (
      !(target instanceof Element) ||
      !target.matches(PERSISTENT_MOBILE_SEARCH_SELECTOR)
    ) {
      return;
    }

    // Upstream search surfaces close on blur, while mobile browsers blur
    // their input whenever the software keyboard is dismissed. Window capture
    // must stop both native blur and React's delegated focusout before either
    // the file-tree handler or the dialog focus-dismiss layer observes them.
    event.stopImmediatePropagation();
  };
  window.addEventListener("blur", retainMobileSearch, true);
  window.addEventListener("focusout", retainMobileSearch, true);

  document.addEventListener(
    "click",
    (event) => {
      if (!shouldUseMobileLayout()) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (
        target.closest(
          '[data-app-shell-sidebar-trigger], button[aria-label="Toggle side panel"]',
        )
      ) {
        return;
      }

      // Menus and dialogs are portalled outside the sidebar and must keep
      // receiving their first pointer event even when they overlap the drawer.
      if (
        target.closest(
          '[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]',
        )
      ) {
        return;
      }

      const panels = [
        document.querySelector<HTMLElement>(RIGHT_PANEL_SELECTOR),
        document.querySelector<HTMLElement>(LEFT_PANEL_SELECTOR),
      ].filter((panel): panel is HTMLElement => {
        if (panel === null) {
          return false;
        }
        return (
          !panel.matches(RIGHT_PANEL_SELECTOR) ||
          panel.dataset.codexPanelOpen !== "false"
        );
      });
      const pointIsOutside = (candidate: HTMLElement): boolean => {
        const rect = candidate.getBoundingClientRect();
        if (rect.width <= 1) {
          return false;
        }

        return (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        );
      };
      const containingPanel = panels.find((candidate) =>
        candidate.contains(target),
      );
      if (containingPanel && !pointIsOutside(containingPanel)) {
        return;
      }

      const panel =
        containingPanel ??
        panels.find((candidate) => pointIsOutside(candidate));
      if (!panel) {
        return;
      }

      // Dismiss only after WebKit has produced a complete click. Closing the
      // drawer on pointerdown changes the hit-tested layout before pointerup,
      // which can suppress the first link or button activation on touch.
      if (panel.matches(RIGHT_PANEL_SELECTOR)) {
        closeRightPanel();
      } else {
        closeLeftSidebar();
      }
    },
    true,
  );
}
