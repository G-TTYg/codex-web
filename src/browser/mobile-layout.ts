/**
 * Owns narrow-viewport layout behavior that the Desktop renderer does not
 * provide. Keep selectors semantic: the renderer's fingerprinted classes
 * change between Desktop releases, while app-shell data attributes do not.
 */

export const MOBILE_VIEWPORT_QUERY = "(max-width: 768px)";

const MOBILE_LAYOUT_STYLES = `
@media ${MOBILE_VIEWPORT_QUERY} {
  [role="menubar"][aria-label="Application menu"] {
    display: none !important;
  }

  aside.app-shell-left-panel {
    position: absolute !important;
    inset: 0 auto 0 0;
    z-index: 40;
    background: var(--color-background-surface-under);
    box-shadow: 12px 0 28px rgb(0 0 0 / 28%);
  }

  /* The pseudo-element is both a scrim and a touch target outside the drawer. */
  aside.app-shell-left-panel::after {
    content: "";
    position: absolute;
    inset-block: 0;
    inset-inline-start: 100%;
    width: calc(100vw - 100%);
    background: rgb(0 0 0 / 22%);
  }

  aside.app-shell-left-panel[style*="width: 0px"] {
    box-shadow: none;
  }

  aside.app-shell-left-panel[style*="width: 0px"]::after {
    display: none;
  }

  aside[data-app-shell-focus-area="right-panel"] {
    position: absolute !important;
    inset: 0 0 0 auto;
    z-index: 41;
    max-width: min(86vw, 320px);
    background: var(--color-background-surface);
    box-shadow: -12px 0 28px rgb(0 0 0 / 28%);
  }

  aside[data-app-shell-focus-area="right-panel"]::before {
    content: "";
    position: absolute;
    inset-block: 0;
    inset-inline-end: 100%;
    width: calc(100vw - 100%);
    background: rgb(0 0 0 / 22%);
  }

  main[data-app-shell-main-surface] {
    width: 100% !important;
  }

  main[data-app-shell-main-surface]
    > header[data-app-shell-application-menu-bar="true"] {
    left: 0 !important;
  }
}
`;

let installed = false;

const LEFT_PANEL_SELECTOR = "aside.app-shell-left-panel";
const RIGHT_PANEL_SELECTOR = 'aside[data-app-shell-focus-area="right-panel"]';

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

      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopImmediatePropagation();
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
