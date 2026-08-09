#!/usr/bin/env node

/**
 * npm's prepare lifecycle has to work from a Git dependency on every host.
 * Windows extracts the exact Store Appx recorded in the runtime manifest;
 * macOS and Linux use the pinned official macOS bundle as their renderer
 * source. Every host prepares the pinned project-local CLI unless an explicit
 * CODEX_CLI_PATH override is present.
 */
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.platform === "win32") {
  const setupArguments = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "./scripts/windows/setup.ps1",
  ];
  // npm has already installed dependency lifecycle scripts before `prepare`.
  // An explicit `npm run build` must also rebuild the host-native addons
  // after the documented `npm ci --ignore-scripts` development install.
  if (process.env.npm_lifecycle_event === "prepare") {
    setupArguments.push("-SkipInstall");
  }
  if (process.env.CODEX_WEB_DOWNLOAD_PROXY) {
    setupArguments.push("-DownloadProxy", process.env.CODEX_WEB_DOWNLOAD_PROXY);
  }
  if (process.env.CODEX_CLI_PATH) setupArguments.push("-SkipPinnedCli");
  run("powershell.exe", setupArguments);
} else {
  run("node", ["./scripts/ensure-electron-runtime.mjs"]);
  // `npm ci --ignore-scripts` intentionally skips native addons. A
  // direct build must restore them for the host Node runtime; during npm's
  // prepare lifecycle their dependency install scripts have already run.
  if (process.env.npm_lifecycle_event !== "prepare") {
    run("npm", ["run", "rebuild:native"]);
  }
  if (!process.env.CODEX_CLI_PATH) {
    run("node", ["./scripts/managed-runtime.mjs", "prepare"]);
  }
  run("bash", ["./scripts/unix/prepare.sh"]);
  run("npm", ["run", "build:browser"]);
  run("npm", ["run", "build:server"]);
}
