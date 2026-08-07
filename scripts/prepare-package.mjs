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
    "./setup-windows.ps1",
    "-SkipInstall",
  ];
  if (process.env.CODEX_CLI_PATH) setupArguments.push("-SkipPinnedCli");
  run("powershell.exe", setupArguments);
} else {
  if (!process.env.CODEX_CLI_PATH) {
    run("node", ["./scripts/managed-runtime.mjs", "prepare"]);
  }
  run("bash", ["./scripts/prepare"]);
  run("npm", ["run", "build:browser"]);
  run("npm", ["run", "build:server"]);
}
