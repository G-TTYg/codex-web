export function mapBrowserPathToInitialRoute(pathname: string, search: string) {
  if (pathname === "/share/receive" && search) {
    const params = new URLSearchParams(search);

    const prompt = ["title", "text", "url"]
      .flatMap((name) => {
        const value = params.get(name);
        return value === null ? [] : [`${name}: ${value}`];
      })
      .join("\n");

    return {
      memoryPath: prompt
        ? `/?${new URLSearchParams({ prompt }).toString()}`
        : "/",
      browserPath: "/",
    };
  }

  const memoryPath = mapBrowserPathToRoute(pathname);
  return {
    // The native memory router owns composer query parameters. Preserve them
    // only for the home route; thread URLs have their own path mapping.
    memoryPath:
      pathname === "/" && search ? `${memoryPath}${search}` : memoryPath,
  };
}

function mapBrowserPathToRoute(pathname: string): string {
  const match = pathname.match(/^\/thread\/([^/]+)$/);
  if (match) {
    try {
      return `/local/${decodeURIComponent(match[1])}`;
    } catch {
      return "/";
    }
  }

  return "/";
}

export function mapMemoryPathToBrowserPath(pathname: string) {
  if (pathname === "/") {
    return { path: "/", titleChange: "Codex" };
  }

  const match = pathname.match(/^\/local\/([^/?#]+)$/);
  if (!match) {
    return null;
  }

  return { path: `/thread/${encodeURIComponent(match[1])}` };
}

export function dispatchNavigateToRoute(path: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "navigate-to-route",
        path,
      },
    }),
  );
}

window.addEventListener("popstate", () => {
  dispatchNavigateToRoute(mapBrowserPathToRoute(window.location.pathname));
});
