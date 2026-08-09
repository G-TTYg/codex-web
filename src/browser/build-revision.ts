/**
 * Keeps a long-lived browser renderer aligned with the server deployment.
 * The browser bundle embeds its own revision while the server announces the
 * revision of the assets it is serving on every WebSocket connection.
 */

export type ServerBuildRevisionMessage = {
  type: "server-build-revision";
  revision: string;
};

export function isServerBuildRevisionMessage(
  value: unknown,
): value is ServerBuildRevisionMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "server-build-revision" &&
    typeof Reflect.get(value, "revision") === "string"
  );
}

export function createBuildRevisionGuard(
  browserRevision: string,
  reload: () => void,
): (message: unknown) => boolean {
  let reloadRequested = false;

  return (message) => {
    if (!isServerBuildRevisionMessage(message)) {
      return false;
    }

    if (message.revision !== browserRevision && !reloadRequested) {
      reloadRequested = true;
      reload();
    }

    return true;
  };
}
