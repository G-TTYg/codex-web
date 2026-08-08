import { MOBILE_VIEWPORT_QUERY } from "./mobile-layout";

const MOBILE_UI_ATTRIBUTE = "data-codex-mobile-ui";
const TOUCH_INPUT_ATTRIBUTE = "data-codex-touch-input";
const CONTEXT_TARGET_SELECTOR = '[data-codex-context-target="true"]';
const ACTION_LAYER_ATTRIBUTE = "data-codex-mobile-action-layer";
const NATIVE_ACTIONS_ATTRIBUTE = "data-codex-mobile-native-actions";

const MOBILE_INTERACTION_STYLES = `
html[${MOBILE_UI_ATTRIBUTE}="true"] [${ACTION_LAYER_ATTRIBUTE}] {
  inset: 0;
  pointer-events: none;
  position: fixed;
  z-index: 48;
}

html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-action-trigger] {
  align-items: center;
  appearance: none;
  background: transparent;
  border: 0;
  border-radius: 7px;
  color: var(--color-token-text-secondary, CanvasText);
  display: flex;
  font: 650 17px/1 system-ui, sans-serif;
  height: 30px;
  justify-content: center;
  letter-spacing: 1px;
  padding: 0 0 4px;
  pointer-events: auto;
  position: fixed;
  touch-action: pan-y;
  width: 30px;
}

html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-action-trigger]:active {
  background: var(--color-token-list-hover-background, rgb(127 127 127 / 16%));
}

/* Reuse renderer-owned row controls instead of covering every row with a
   portal affordance. The marker is applied only to a hover-gated wrapper. */
html[${MOBILE_UI_ATTRIBUTE}="true"] [${NATIVE_ACTIONS_ATTRIBUTE}="true"] {
  display: flex !important;
  opacity: 1 !important;
  pointer-events: auto !important;
  visibility: visible !important;
  width: auto !important;
}

html[${MOBILE_UI_ATTRIBUTE}="true"]
  [${NATIVE_ACTIONS_ATTRIBUTE}="true"]
  :is(button, a, [role="button"]) {
  min-height: 30px !important;
  min-width: 30px !important;
  touch-action: pan-y !important;
}

html[${MOBILE_UI_ATTRIBUTE}="true"] [${ACTION_LAYER_ATTRIBUTE}][data-scrolling="true"]
  [data-codex-mobile-action-trigger] {
  opacity: 0;
  pointer-events: none;
}

html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-sheet-backdrop] {
  align-items: end;
  background: rgb(0 0 0 / 38%);
  display: flex;
  inset: 0;
  overscroll-behavior: contain;
  pointer-events: auto;
  position: fixed;
  touch-action: none;
  z-index: 120;
}

html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-sheet] {
  background: var(--color-token-dropdown-background, Canvas);
  border-radius: 22px 22px 0 0;
  box-shadow: 0 -12px 36px rgb(0 0 0 / 25%);
  color: var(--color-token-foreground, CanvasText);
  max-height: min(72dvh, 620px);
  overflow: auto;
  padding: 8px 10px calc(10px + env(safe-area-inset-bottom));
  touch-action: pan-y;
  width: 100%;
}

html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-sheet-header] {
  align-items: center;
  display: flex;
  gap: 12px;
  min-height: 48px;
  padding: 2px 6px 6px 12px;
}

html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-sheet-title] {
  flex: 1;
  font: 600 15px/1.3 system-ui, sans-serif;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-sheet-close],
html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-sheet-action] {
  appearance: none;
  background: transparent;
  border: 0;
  color: inherit;
  font: 500 16px/1.25 system-ui, sans-serif;
}

html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-sheet-close] {
  border-radius: 999px;
  font-size: 24px;
  height: 44px;
  width: 44px;
}

html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-sheet-action] {
  border-radius: 12px;
  display: block;
  min-height: 48px;
  padding: 12px 14px;
  text-align: start;
  width: 100%;
}

html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-sheet-action]:active,
html[${MOBILE_UI_ATTRIBUTE}="true"] [data-codex-mobile-sheet-close]:active {
  background: var(--color-token-list-hover-background, rgb(127 127 127 / 16%));
}

/* Present renderer-owned pointer menus as the same mobile bottom sheet. */
html[${MOBILE_UI_ATTRIBUTE}="true"]
  [data-radix-popper-content-wrapper]:has(> [role="menu"]) {
  inset: auto 0 0 !important;
  max-width: none !important;
  min-width: 100vw !important;
  position: fixed !important;
  transform: none !important;
  width: 100vw !important;
  z-index: 110 !important;
}

html[${MOBILE_UI_ATTRIBUTE}="true"]
  [data-radix-popper-content-wrapper] > [role="menu"] {
  border-radius: 22px 22px 0 0 !important;
  max-height: min(72dvh, 620px) !important;
  min-width: 0 !important;
  overflow: auto !important;
  padding: 10px 10px calc(10px + env(safe-area-inset-bottom)) !important;
  width: 100% !important;
}

html[${MOBILE_UI_ATTRIBUTE}="true"]
  :is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]) {
  min-height: 48px;
  padding: 12px 14px !important;
}

/* A touch sequence on a draggable row remains native vertical panning. */
html[${TOUCH_INPUT_ATTRIBUTE}="true"] [draggable="true"] {
  -webkit-touch-callout: none;
  -webkit-user-drag: none !important;
  touch-action: pan-y pinch-zoom;
  user-select: none;
}

html[${TOUCH_INPUT_ATTRIBUTE}="true"] [data-app-action-sidebar-scroll],
html[${TOUCH_INPUT_ATTRIBUTE}="true"] [data-file-tree-virtualized-scroll] {
  -webkit-overflow-scrolling: touch;
  min-height: 0;
  overflow-y: auto !important;
  overscroll-behavior-y: contain;
  touch-action: pan-y pinch-zoom !important;
}

html[${TOUCH_INPUT_ATTRIBUTE}="true"] [data-app-action-sidebar-scroll] *,
html[${TOUCH_INPUT_ATTRIBUTE}="true"] [data-file-tree-virtualized-scroll] * {
  -webkit-user-drag: none !important;
  touch-action: pan-y pinch-zoom !important;
}
`;

type MobileAction = {
  activate: () => void;
  disabled?: boolean;
  key: HTMLElement | string;
  label: string;
};

type RendererMenuItem = {
  checked?: boolean;
  enabled?: boolean;
  id: string;
  nativeLabel?: string;
  submenu?: RendererMenuItem[];
  type?: string;
};

type RendererMenuSelect = (id: string, items: RendererMenuItem[]) => void;

type MobileActionRequestEvent = MouseEvent & {
  codexMobileActionRequest?: (
    items: RendererMenuItem[],
    select: RendererMenuSelect,
  ) => void;
};

type ActionTarget = {
  actions: MobileAction[];
  contextTarget: HTMLElement | null;
  hasNativeControls: boolean;
  host: HTMLElement;
};

type ActionOverlay = {
  button: HTMLButtonElement;
  target: ActionTarget;
};

const messages = {
  en: {
    actions: "Actions",
    close: "Close",
  },
  zhHans: {
    actions: "操作",
    close: "关闭",
  },
  zhHant: {
    actions: "操作",
    close: "關閉",
  },
};

let installed = false;
let actionLayer: HTMLDivElement | null = null;
let activeSheet: HTMLDivElement | null = null;
let restoreFocus: HTMLElement | null = null;
let mutationObserver: MutationObserver | null = null;
let animationFrame = 0;
let targetsDirty = true;
let scrollEndTimer = 0;
const overlays = new Map<HTMLElement, ActionOverlay>();

function getMessages(): (typeof messages)[keyof typeof messages] {
  const language = document.documentElement.lang.toLowerCase();
  if (
    language.startsWith("zh-tw") ||
    language.startsWith("zh-hk") ||
    language.includes("hant")
  ) {
    return messages.zhHant;
  }
  if (language.startsWith("zh") || language.includes("hans")) {
    return messages.zhHans;
  }
  return messages.en;
}

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

function mobileUiEnabled(): boolean {
  return document.documentElement.getAttribute(MOBILE_UI_ATTRIBUTE) === "true";
}

function touchInputEnabled(): boolean {
  return (
    document.documentElement.getAttribute(TOUCH_INPUT_ATTRIBUTE) === "true"
  );
}

function hasHoverVisibilityClass(element: Element): boolean {
  const className = element.getAttribute("class") ?? "";
  return /group-(?:hover|focus-within)(?:\/[\w-]+)?:[^\s]*(?:opacity|pointer-events|visible|hidden|block|flex|inline|width|w-)/.test(
    className,
  );
}

function exposeNativeControl(control: HTMLElement): void {
  let candidate: HTMLElement | null = control;
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    if (hasHoverVisibilityClass(candidate)) {
      if (candidate.getAttribute(NATIVE_ACTIONS_ATTRIBUTE) !== "true") {
        candidate.setAttribute(NATIVE_ACTIONS_ATTRIBUTE, "true");
      }
      return;
    }
    candidate = candidate.parentElement;
  }
}

function isHoverOnlyControl(control: HTMLElement): boolean {
  let candidate: Element | null = control;
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    if (hasHoverVisibilityClass(candidate)) {
      return true;
    }
    candidate = candidate.parentElement;
  }
  return false;
}

function elementLabel(element: HTMLElement): string {
  const label =
    element.getAttribute("aria-label") ??
    element.getAttribute("title") ??
    element.getAttribute("data-label") ??
    element.textContent ??
    "";
  return label.replace(/\s+/g, " ").trim().slice(0, 96);
}

function findActionHost(control: HTMLElement): HTMLElement | null {
  const semanticHost = control.closest<HTMLElement>(
    `${CONTEXT_TARGET_SELECTOR}, [data-thread-title-trigger], [data-type="item"], [role="treeitem"], [role="listitem"], [role="option"], [role="tab"], li`,
  );
  if (semanticHost && semanticHost !== control) {
    return semanticHost;
  }

  let candidate = control.parentElement;
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    const hasGroupClass = Array.from(candidate.classList).some(
      (token) => token === "group" || token.startsWith("group/"),
    );
    if (hasGroupClass) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return null;
}

function collectActionTargets(): Map<HTMLElement, ActionTarget> {
  const result = new Map<HTMLElement, ActionTarget>();
  for (const contextTarget of document.querySelectorAll<HTMLElement>(
    CONTEXT_TARGET_SELECTOR,
  )) {
    // The shared renderer wrapper also surrounds the empty application header.
    // It is not an item and its native menu has no useful mobile actions.
    if (
      contextTarget.matches("[data-app-shell-application-menu-bar]") ||
      !elementLabel(contextTarget)
    ) {
      continue;
    }
    // Nested context wrappers describe the same visual item. Keep the deepest
    // owner so portal buttons never stack at identical coordinates.
    if (contextTarget.querySelector(CONTEXT_TARGET_SELECTOR)) {
      continue;
    }
    result.set(contextTarget, {
      actions: [],
      contextTarget,
      hasNativeControls: false,
      host: contextTarget,
    });
  }

  for (const control of document.querySelectorAll<HTMLElement>(
    'button, a, [role="button"]',
  )) {
    if (
      control.closest(`[${ACTION_LAYER_ATTRIBUTE}]`) ||
      control.hasAttribute("disabled") ||
      control.getAttribute("aria-hidden") === "true" ||
      !isHoverOnlyControl(control)
    ) {
      continue;
    }

    const label = elementLabel(control);
    const host = findActionHost(control);
    if (!label || !host) {
      continue;
    }

    const contextTarget = host.matches(CONTEXT_TARGET_SELECTOR)
      ? host
      : host.closest<HTMLElement>(CONTEXT_TARGET_SELECTOR);
    const actionHost = contextTarget ?? host;
    const target = result.get(actionHost) ?? {
      actions: [],
      contextTarget,
      hasNativeControls: false,
      host: actionHost,
    };
    if (!target.actions.some((action) => action.key === control)) {
      target.actions.push({
        activate: () => control.click(),
        key: control,
        label,
      });
    }
    result.set(actionHost, target);
  }
  for (const target of result.values()) {
    const hasRendererMenu = target.actions.some(
      (action) =>
        action.key instanceof HTMLElement &&
        action.key.getAttribute("aria-haspopup") === "menu",
    );
    if (!hasRendererMenu) {
      continue;
    }
    // When a row already owns a renderer menu, reveal that native group in
    // place (including adjacent primary actions such as "new chat"). Rows
    // with only hover shortcuts keep one compact mobile action button instead
    // of exposing destructive actions such as Archive on every list item.
    target.hasNativeControls = true;
    for (const action of target.actions) {
      if (action.key instanceof HTMLElement) {
        exposeNativeControl(action.key);
      }
    }
  }
  return result;
}

function needsActionTrigger(target: ActionTarget): boolean {
  return (
    !target.hasNativeControls &&
    (target.contextTarget !== null || target.actions.length > 0)
  );
}

function isVisibleTarget(target: HTMLElement): boolean {
  if (!target.isConnected || target.closest('[aria-hidden="true"]')) {
    return false;
  }
  const rect = target.getBoundingClientRect();
  return (
    rect.width >= 20 &&
    rect.height >= 20 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

function rendererMenuActions(
  items: RendererMenuItem[],
  select: RendererMenuSelect,
  parents: string[] = [],
): MobileAction[] {
  const actions: MobileAction[] = [];
  for (const item of items) {
    if (item.type === "separator") {
      continue;
    }
    const baseLabel = (item.nativeLabel || item.id).replace(/\s+/g, " ").trim();
    if (!baseLabel) {
      continue;
    }
    const ownLabel =
      item.type === "checkbox" && item.checked ? `✓ ${baseLabel}` : baseLabel;
    const path = [...parents, ownLabel];
    if (item.submenu?.length) {
      actions.push(...rendererMenuActions(item.submenu, select, path));
      continue;
    }
    actions.push({
      activate: () => select(item.id, items),
      disabled: item.enabled === false,
      key: `renderer:${path.join("/")}:${item.id}`,
      label: path.join(" › "),
    });
  }
  return actions;
}

function requestRendererActions(
  target: HTMLElement,
  resolve: (actions: MobileAction[]) => void,
): void {
  if (!target.isConnected) {
    return;
  }
  const rect = target.getBoundingClientRect();
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: Math.min(window.innerWidth - 16, Math.max(16, rect.right - 20)),
    clientY: Math.min(window.innerHeight - 16, Math.max(16, rect.bottom)),
    view: window,
  }) as MobileActionRequestEvent;
  // The semantic renderer patch recognizes this callback before its native
  // Electron-menu path. This transfers action semantics without emulating a
  // secondary click or exposing renderer internals globally.
  event.codexMobileActionRequest = (items, select) => {
    resolve(rendererMenuActions(items, select));
  };
  target.dispatchEvent(event);
}

function closeActionSheet(): void {
  activeSheet?.remove();
  activeSheet = null;
  if (restoreFocus?.isConnected) {
    restoreFocus.focus({ preventScroll: true });
  }
  restoreFocus = null;
}

function appendSheetAction(container: HTMLElement, action: MobileAction): void {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.codexMobileSheetAction = "true";
  button.disabled = action.disabled === true;
  button.textContent = action.label;
  button.addEventListener("click", () => {
    closeActionSheet();
    requestAnimationFrame(action.activate);
  });
  container.append(button);
}

function openResolvedActionSheet(
  target: ActionTarget,
  trigger: HTMLElement,
  availableActions: MobileAction[],
): void {
  if (availableActions.length === 0) {
    return;
  }

  closeActionSheet();
  const copy = getMessages();
  restoreFocus = trigger;

  const backdrop = document.createElement("div");
  backdrop.dataset.codexMobileSheetBackdrop = "true";
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closeActionSheet();
    }
  });

  const sheet = document.createElement("section");
  sheet.dataset.codexMobileSheet = "true";
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("role", "dialog");

  const header = document.createElement("header");
  header.dataset.codexMobileSheetHeader = "true";
  const title = document.createElement("h2");
  title.dataset.codexMobileSheetTitle = "true";
  title.id = "codex-mobile-sheet-title";
  title.textContent = elementLabel(target.host) || copy.actions;
  sheet.setAttribute("aria-labelledby", title.id);
  const close = document.createElement("button");
  close.type = "button";
  close.dataset.codexMobileSheetClose = "true";
  close.setAttribute("aria-label", copy.close);
  close.textContent = "×";
  close.addEventListener("click", closeActionSheet);
  header.append(title, close);

  const actions = document.createElement("div");
  for (const action of availableActions) {
    appendSheetAction(actions, action);
  }

  sheet.append(header, actions);
  backdrop.append(sheet);
  // The affordance portal intentionally sits below renderer menus. Mount the
  // modal sheet directly under body so its own stacking context can sit above
  // menus and drawers without also raising every row affordance.
  document.body.append(backdrop);
  activeSheet = backdrop;
  close.focus({ preventScroll: true });
}

function openActionSheet(target: ActionTarget, trigger: HTMLElement): void {
  const connectedActions = target.actions.filter(
    (action) => !(action.key instanceof HTMLElement) || action.key.isConnected,
  );
  if (!target.contextTarget) {
    openResolvedActionSheet(target, trigger, connectedActions);
    return;
  }

  let resolved = false;
  const fallbackTimer = window.setTimeout(() => {
    if (!resolved) {
      openResolvedActionSheet(target, trigger, connectedActions);
    }
  }, 300);
  requestRendererActions(target.contextTarget, (rendererActions) => {
    resolved = true;
    window.clearTimeout(fallbackTimer);
    openResolvedActionSheet(target, trigger, [
      ...connectedActions,
      ...rendererActions,
    ]);
  });
}

function createOverlay(target: ActionTarget): ActionOverlay {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.codexMobileActionTrigger = "true";
  button.textContent = "⋯";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openActionSheet(overlays.get(target.host)?.target ?? target, button);
  });
  actionLayer?.append(button);
  return { button, target };
}

function positionOverlay(overlay: ActionOverlay): void {
  const { button, target } = overlay;
  const rect = target.host.getBoundingClientRect();
  const naturalTop =
    rect.height <= 56 ? rect.top + (rect.height - 30) / 2 : rect.top + 6;
  const top = Math.max(4, Math.min(window.innerHeight - 34, naturalTop));
  const left = Math.max(4, Math.min(window.innerWidth - 34, rect.right - 34));
  button.style.left = `${left}px`;
  button.style.top = `${top}px`;
  const copy = getMessages();
  const label = elementLabel(target.host);
  button.setAttribute(
    "aria-label",
    label ? `${copy.actions}: ${label}` : copy.actions,
  );
}

function renderActionLayer(): void {
  animationFrame = 0;
  if (!actionLayer || !mobileUiEnabled()) {
    for (const overlay of overlays.values()) {
      overlay.button.remove();
    }
    overlays.clear();
    closeActionSheet();
    return;
  }

  const targets = targetsDirty ? collectActionTargets() : null;
  targetsDirty = false;
  if (targets) {
    for (const [host, overlay] of overlays) {
      const next = targets.get(host);
      if (!next || !needsActionTrigger(next)) {
        overlay.button.remove();
        overlays.delete(host);
      } else {
        overlay.target = next;
      }
    }
    for (const [host, target] of targets) {
      if (needsActionTrigger(target) && !overlays.has(host)) {
        overlays.set(host, createOverlay(target));
      }
    }
  }

  for (const [host, overlay] of overlays) {
    if (!isVisibleTarget(host)) {
      overlay.button.hidden = true;
      continue;
    }
    overlay.button.hidden = false;
    positionOverlay(overlay);
  }
}

function scheduleRender(markTargetsDirty = false): void {
  targetsDirty ||= markTargetsDirty;
  if (!animationFrame) {
    animationFrame = requestAnimationFrame(renderActionLayer);
  }
}

function onScrollActivity(): void {
  if (!actionLayer || !mobileUiEnabled()) {
    return;
  }
  actionLayer.dataset.scrolling = "true";
  window.clearTimeout(scrollEndTimer);
  scrollEndTimer = window.setTimeout(() => {
    actionLayer?.removeAttribute("data-scrolling");
    scheduleRender();
  }, 120);
  scheduleRender();
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

function startActionLayer(): void {
  if (actionLayer) {
    return;
  }
  actionLayer = document.createElement("div");
  actionLayer.setAttribute(ACTION_LAYER_ATTRIBUTE, "true");
  document.body.append(actionLayer);

  mutationObserver = new MutationObserver((records) => {
    // Positioning the portal buttons mutates their style attributes. Ignore
    // mutations owned by this layer so layout updates cannot schedule an
    // endless observer/render loop.
    if (
      records.some(
        (record) =>
          !(record.target instanceof Node) ||
          !actionLayer?.contains(record.target),
      )
    ) {
      scheduleRender(true);
    }
  });
  mutationObserver.observe(document.body, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  document.addEventListener("scroll", onScrollActivity, true);
  document.addEventListener("touchmove", onScrollActivity, {
    capture: true,
    passive: true,
  });
  window.addEventListener("resize", () => scheduleRender(true));
  scheduleRender(true);
}

export function installMobileInteractions(): void {
  if (installed) {
    return;
  }
  installed = true;
  installStyles();

  const mobileMediaQuery = matchMedia(MOBILE_VIEWPORT_QUERY);
  const coarsePointerQuery = matchMedia("(hover: none), (pointer: coarse)");
  const updateMobileMode = (): void => {
    setAttribute(MOBILE_UI_ATTRIBUTE, mobileMediaQuery.matches);
    if (coarsePointerQuery.matches) {
      setAttribute(TOUCH_INPUT_ATTRIBUTE, true);
    }
    scheduleRender(true);
  };
  updateMobileMode();
  mobileMediaQuery.addEventListener("change", updateMobileMode);
  coarsePointerQuery.addEventListener("change", updateMobileMode);

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("dragstart", onDragStart, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeActionSheet();
    }
  });

  if (document.body) {
    startActionLayer();
  } else {
    window.addEventListener("DOMContentLoaded", startActionLayer, {
      once: true,
    });
  }
}
