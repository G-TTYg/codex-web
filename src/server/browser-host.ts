import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  isBrowserHostMessage,
  type BrowserEditableRect,
  type BrowserHostCreateOptions,
  type BrowserHostEventMessage,
  type BrowserHostState,
  type BrowserHostToServerMessage,
  type ServerToBrowserHostMessage,
} from "./browser-host-protocol";

type BrowserHostSessionCallbacks = {
  onBeforeRequest: (
    details: Record<string, unknown>,
  ) => Promise<{ cancel?: boolean }>;
  onClosed: (errorMessage?: string) => void;
  onCreated: (state: BrowserHostState) => void;
  onEvent: (message: BrowserHostEventMessage) => void;
  onFrame: (frame: {
    data: Buffer;
    editableRects: BrowserEditableRect[];
    height: number;
    width: number;
  }) => void;
  onIpcInvoke: (channel: string, args: unknown[]) => Promise<unknown>;
  onIpcMessage: (channel: string, args: unknown[]) => void;
};

type PendingCommand = {
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
};

const READY_TIMEOUT_MS = 15_000;

export function resolveElectronExecutable(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override = environment.CODEX_WEB_ELECTRON_PATH?.trim();
  if (override) {
    const resolvedOverride = path.resolve(override);
    if (!fs.existsSync(resolvedOverride)) {
      throw new Error(
        `CODEX_WEB_ELECTRON_PATH does not exist: ${resolvedOverride}`,
      );
    }
    return resolvedOverride;
  }

  const electronPackageJson = require.resolve("electron/package.json", {
    paths: [projectRoot],
  });
  const electronPackageRoot = path.dirname(electronPackageJson);
  const executableNamePath = path.join(electronPackageRoot, "path.txt");
  if (!fs.existsSync(executableNamePath)) {
    throw new Error(
      "Electron's host executable is missing. Reinstall dependencies without " +
        "disabling the electron download, or set CODEX_WEB_ELECTRON_PATH.",
    );
  }

  const executableName = fs.readFileSync(executableNamePath, "utf8").trim();
  const executablePath = path.join(electronPackageRoot, "dist", executableName);
  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `Electron host executable does not exist: ${executablePath}`,
    );
  }
  return executablePath;
}

/**
 * Lazily owns the one Electron helper process used by every Browser tab. The
 * ordinary Desktop shell continues to execute in plain Node; only untrusted
 * guest pages cross this explicit sidecar boundary.
 */
export class BrowserHost {
  private child: ChildProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimeout: NodeJS.Timeout | null = null;
  private disposed = false;
  private requestSequence = 0;
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly sessions = new Map<string, BrowserHostSessionCallbacks>();
  private readonly expectedElectronVersion: string;

  constructor(private readonly projectRoot: string) {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    ) as { dependencies?: { electron?: unknown } };
    const electronVersion = packageJson.dependencies?.electron;
    if (typeof electronVersion !== "string" || !electronVersion) {
      throw new Error(
        "package.json must pin Electron as a runtime dependency.",
      );
    }
    this.expectedElectronVersion = electronVersion;
  }

  createSession(
    options: BrowserHostCreateOptions,
    callbacks: BrowserHostSessionCallbacks,
  ): void {
    if (this.disposed) {
      callbacks.onClosed("The Browser host has shut down.");
      return;
    }

    this.sessions
      .get(options.sessionId)
      ?.onClosed("The Browser view was replaced by a newer view.");
    this.sessions.set(options.sessionId, callbacks);
    void this.ensureStarted()
      .then(() => {
        if (this.sessions.get(options.sessionId) !== callbacks) {
          return;
        }
        this.send({ type: "create", ...options });
      })
      .catch((error: unknown) => {
        if (this.sessions.get(options.sessionId) !== callbacks) {
          return;
        }
        this.sessions.delete(options.sessionId);
        callbacks.onClosed(
          error instanceof Error ? error.message : String(error),
        );
      });
  }

  async command(
    sessionId: string,
    method: string,
    args: unknown[] = [],
  ): Promise<unknown> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Browser view is not available: ${sessionId}`);
    }
    await this.ensureStarted();

    const requestId = `browser_host_${++this.requestSequence}`;
    return await new Promise((resolve, reject) => {
      this.pendingCommands.set(requestId, { resolve, reject });
      try {
        this.send({
          type: "command",
          sessionId,
          requestId,
          method,
          args,
        });
      } catch (error) {
        this.pendingCommands.delete(requestId);
        reject(error);
      }
    });
  }

  notify(sessionId: string, method: string, args: unknown[] = []): void {
    if (!this.sessions.has(sessionId)) {
      return;
    }
    void this.ensureStarted()
      .then(() => {
        if (this.sessions.has(sessionId)) {
          this.send({ type: "command", sessionId, method, args });
        }
      })
      .catch((error: unknown) => {
        this.closeSession(
          sessionId,
          error instanceof Error ? error.message : String(error),
        );
      });
  }

  destroySession(sessionId: string): void {
    const existed = this.sessions.delete(sessionId);
    if (existed && this.child?.connected) {
      this.send({ type: "destroy", sessionId });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const sessionId of [...this.sessions.keys()]) {
      this.closeSession(sessionId, "The Browser host has shut down.");
    }
    this.rejectPendingCommands(new Error("The Browser host has shut down."));

    const child = this.child;
    this.child = null;
    if (!child) {
      return;
    }
    if (child.connected) {
      child.send({ type: "shutdown" } satisfies ServerToBrowserHostMessage);
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      timeout.unref();
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error("The Browser host has shut down.");
    }
    if (this.readyPromise) {
      return await this.readyPromise;
    }

    const electronExecutable = resolveElectronExecutable(this.projectRoot);
    const helperEntry = path.resolve(__dirname, "browser-host-electron.js");
    if (!fs.existsSync(helperEntry)) {
      throw new Error(`Browser host entry does not exist: ${helperEntry}`);
    }

    const childEnvironment = { ...process.env };
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    childEnvironment.CODEX_WEB_PROJECT_ROOT = this.projectRoot;

    const child = spawn(electronExecutable, [helperEntry], {
      cwd: this.projectRoot,
      env: childEnvironment,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      process.stderr.write(`[browser-host] ${String(chunk)}`);
    });
    child.on("message", (message: unknown) => this.handleMessage(message));
    child.once("error", (error) => this.handleProcessFailure(error));
    child.once("exit", (code, signal) => {
      this.handleProcessFailure(
        new Error(
          `Browser host exited${signal ? ` from ${signal}` : ` with code ${code ?? "unknown"}`}.`,
        ),
      );
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimeout = setTimeout(() => {
        this.handleProcessFailure(
          new Error("Timed out while starting the Browser host."),
        );
      }, READY_TIMEOUT_MS);
      this.readyTimeout.unref();
    });
    return await this.readyPromise;
  }

  private send(message: ServerToBrowserHostMessage): void {
    if (!this.child?.connected) {
      throw new Error("Browser host IPC is not connected.");
    }
    this.child.send(message);
  }

  private handleMessage(value: unknown): void {
    if (!isBrowserHostMessage(value)) {
      console.error("[browser-host] ignored an invalid helper message");
      return;
    }
    const message = value as BrowserHostToServerMessage;
    if (message.type === "ready") {
      if (message.electronVersion !== this.expectedElectronVersion) {
        const error = new Error(
          `Browser host Electron version mismatch: expected ${this.expectedElectronVersion}, got ${message.electronVersion}.`,
        );
        this.child?.kill();
        this.handleProcessFailure(error);
        return;
      }
      if (this.readyTimeout) {
        clearTimeout(this.readyTimeout);
        this.readyTimeout = null;
      }
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }

    if (message.type === "command-result" || message.type === "command-error") {
      const pending = this.pendingCommands.get(message.requestId);
      if (!pending) {
        return;
      }
      this.pendingCommands.delete(message.requestId);
      if (message.type === "command-result") {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.errorMessage));
      }
      return;
    }

    const callbacks = this.sessions.get(message.sessionId);
    if (!callbacks) {
      if (message.type === "before-request" || message.type === "ipc-invoke") {
        this.send({
          type: "host-request-result",
          requestId: message.requestId,
          errorMessage: "The Browser view is no longer available.",
        });
      }
      return;
    }
    switch (message.type) {
      case "created":
        callbacks.onCreated(message.state);
        break;
      case "event":
        callbacks.onEvent(message);
        break;
      case "frame":
        callbacks.onFrame({
          data: message.data,
          editableRects: message.editableRects,
          height: message.height,
          width: message.width,
        });
        break;
      case "ipc-message":
        callbacks.onIpcMessage(message.channel, message.args);
        break;
      case "before-request":
        void callbacks
          .onBeforeRequest(message.details)
          .then((result) => {
            this.send({
              type: "host-request-result",
              requestId: message.requestId,
              result,
            });
          })
          .catch((error: unknown) => {
            this.send({
              type: "host-request-result",
              requestId: message.requestId,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
          });
        break;
      case "ipc-invoke":
        void callbacks
          .onIpcInvoke(message.channel, message.args)
          .then((result) => {
            this.send({
              type: "host-request-result",
              requestId: message.requestId,
              result,
            });
          })
          .catch((error: unknown) => {
            this.send({
              type: "host-request-result",
              requestId: message.requestId,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
          });
        break;
      case "closed":
        this.sessions.delete(message.sessionId);
        callbacks.onClosed(message.errorMessage);
        break;
    }
  }

  private handleProcessFailure(error: Error): void {
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = null;
    this.child = null;
    this.rejectPendingCommands(error);
    for (const sessionId of [...this.sessions.keys()]) {
      this.closeSession(sessionId, error.message);
    }
  }

  private closeSession(sessionId: string, errorMessage?: string): void {
    const callbacks = this.sessions.get(sessionId);
    if (!callbacks) {
      return;
    }
    this.sessions.delete(sessionId);
    callbacks.onClosed(errorMessage);
  }

  private rejectPendingCommands(error: Error): void {
    for (const pending of this.pendingCommands.values()) {
      pending.reject(error);
    }
    this.pendingCommands.clear();
  }
}
