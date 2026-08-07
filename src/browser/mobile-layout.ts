/**
 * Owns narrow-viewport layout behavior that the Desktop renderer does not
 * provide. Keep selectors semantic: the renderer's fingerprinted classes
 * change between Desktop releases, while app-shell data attributes do not.
 */

// Desktop device emulation and iPad browsers must select the same layout from
// capabilities, not user-agent strings. Modern portrait iPads exceed 768 CSS
// pixels but still have a coarse primary pointer and no hover input.
export const MOBILE_VIEWPORT_QUERY =
  "(max-width: 768px), (hover: none) and (pointer: coarse) and (max-width: 1024px) and (orientation: portrait)";

const MOBILE_LAYOUT_STYLES = `
@media ${MOBILE_VIEWPORT_QUERY} {
  aside.app-shell-left-panel {
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

  aside.app-shell-left-panel[style*="width: 0px"] {
    box-shadow: none;
  }

  aside[data-app-shell-focus-area="right-panel"] {
    position: absolute !important;
    inset: 0 0 0 auto;
    z-index: 41;
    max-width: min(86vw, 320px);
    isolation: isolate;
    background:
      linear-gradient(
        var(--color-background-surface, Canvas),
        var(--color-background-surface, Canvas)
      ),
      Canvas;
    box-shadow: -12px 0 28px rgb(0 0 0 / 28%);
  }

  main[data-app-shell-main-surface] {
    width: 100% !important;
  }
}
`;

let installed = false;

const LEFT_PANEL_SELECTOR = "aside.app-shell-left-panel";
const RIGHT_PANEL_SELECTOR = 'aside[data-app-shell-focus-area="right-panel"]';
const PERSISTENT_MOBILE_SEARCH_SELECTOR =
  '[data-file-tree-search-input], [cmdk-input], [role="searchbox"], input[type="search"]';
const TOUCH_INPUT_SELECTOR = 'html[data-codex-touch-input="true"]';

function installMobileLayoutStyles(): void {
  if (document.querySelector("style[data-codex-mobile-layout]")) {
    return;
  }

  const style = document.createElement("style");
  style.dataset.codexMobileLayout = "true";
  style.textContent = MOBILE_LAYOUT_STYLES;
  (document.head ?? document.documentElement).append(style);
}

export function installMobileLayout(closeSidebar: () => void): void {
  if (installed) {
    return;
  }
  installed = true;

  installMobileLayoutStyles();
  const mobileMediaQuery = matchMedia(MOBILE_VIEWPORT_QUERY);

  const retainMobileSearch = (event: FocusEvent): void => {
    if (
      !mobileMediaQuery.matches &&
      !document.documentElement.matches(TOUCH_INPUT_SELECTOR)
    ) {
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
    "pointerdown",
    (event) => {
      if (!mobileMediaQuery.matches) {
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
      // receiving their first pointer event even when they overlap the scrim.
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
      ].filter((panel): panel is HTMLElement => panel !== null);
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

      // The document listener can dismiss an overlay without a full-screen
      // pseudo-element scrim. Keep the original pointer sequence alive so a
      // first touch on an underlying link or button still activates it.
      if (panel.matches(RIGHT_PANEL_SELECTOR)) {
        document
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Toggle side panel"][aria-pressed="true"]',
          )
          ?.click();
      } else {
        closeSidebar();
      }
    },
    true,
  );
}
