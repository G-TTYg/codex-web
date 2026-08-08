/**
 * Coordinates renderer-owned context menus whose items are loaded lazily.
 *
 * Electron can await those items before asking the OS to display a menu. The
 * browser renderer uses a controlled Radix menu instead, so it must keep that
 * menu closed until the same item loader has completed. One coordinator is
 * shared by every menu instance to prevent a slower request from reopening an
 * older target after the user has moved to another one.
 */

export type SetRendererContextMenuOpen = (
  open: boolean,
  awaitBeforeOpen: boolean,
  loadAwaitedItems: () => PromiseLike<readonly unknown[]>,
  loadImmediateItems: () => readonly unknown[],
  setOpen: (open: boolean) => void,
) => void;

export function createRendererContextMenuCoordinator(): SetRendererContextMenuOpen {
  let latestRequest = 0;
  let activeMenuSetter: ((open: boolean) => void) | null = null;

  return (
    open,
    awaitBeforeOpen,
    loadAwaitedItems,
    loadImmediateItems,
    setOpen,
  ) => {
    if (!open) {
      setOpen(false);
      if (activeMenuSetter === setOpen) {
        activeMenuSetter = null;
      }
      return;
    }

    const request = ++latestRequest;
    const previousMenuSetter = activeMenuSetter;
    activeMenuSetter = setOpen;
    if (previousMenuSetter !== null && previousMenuSetter !== setOpen) {
      previousMenuSetter(false);
    }

    if (!awaitBeforeOpen) {
      loadImmediateItems();
      if (request === latestRequest && activeMenuSetter === setOpen) {
        setOpen(true);
      }
      return;
    }

    // Keep Radix controlled and closed while the renderer resolves dynamic
    // file targets. Opening with no children can otherwise be discarded before
    // the async menu entries arrive.
    setOpen(false);
    void Promise.resolve()
      .then(loadAwaitedItems)
      .then((items) => {
        if (request !== latestRequest || activeMenuSetter !== setOpen) {
          return;
        }
        if (items.length === 0) {
          activeMenuSetter = null;
          return;
        }
        setOpen(true);
      })
      .catch(() => {
        if (request === latestRequest && activeMenuSetter === setOpen) {
          activeMenuSetter = null;
          setOpen(false);
        }
      });
  };
}
