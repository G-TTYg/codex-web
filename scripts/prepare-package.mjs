#!/usr/bin/env node

/**
 * npm's prepare lifecycle has to work from a Git dependency on every host.
 * Windows extracts the locally installed Store package; macOS and Linux use
 * the official macOS bundle as the architecture-independent renderer source.
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
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "./setup-windows.ps1",
    "-SkipInstall",
  ]);
} else {
  run("bash", ["./scripts/prepare"]);
  run("npm", ["run", "build:browser"]);
  run("npm", ["run", "build:server"]);
}
