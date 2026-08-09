/**
 * Routes renderer requests for a web URL back through the Desktop Browser
 * panel. In a hosted renderer, opening a real browser window would escape the
 * Codex UI and can also be rejected as a popup on mobile WebKit.
 */

type BrowserMessageTarget = {
  location: Pick<Location, "origin">;
  postMessage: (message: unknown, targetOrigin: string) => void;
};

export function openUrlInEmbeddedBrowser(
  url: string,
  target: BrowserMessageTarget = window,
): void {
  target.postMessage(
    {
      type: "toggle-browser-panel",
      open: true,
      url,
      source: "manual",
      initiator: "open_in_browser_bridge",
    },
    target.location.origin,
  );
}
