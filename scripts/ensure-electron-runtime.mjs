#!/usr/bin/env node

/**
 * Restores Electron's platform executable after the documented
 * `npm ci --ignore-scripts` install. The npm package remains the version and
 * checksum authority; this wrapper only makes the skipped install step
 * explicit and routes it through codex-web's managed-download proxy setting.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, "..");
const proxyOptionIndex = process.argv.indexOf("--proxy");
const proxy =
  proxyOptionIndex >= 0
    ? process.argv[proxyOptionIndex + 1]?.trim()
    : process.env.CODEX_WEB_DOWNLOAD_PROXY?.trim();
if (proxyOptionIndex >= 0 && !proxy) {
  throw new Error("--proxy requires a value.");
}
const projectPackage = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const expectedVersion = projectPackage.dependencies?.electron;
if (typeof expectedVersion !== "string" || !expectedVersion) {
  throw new Error("package.json must pin Electron as a runtime dependency.");
}

const override = process.env.CODEX_WEB_ELECTRON_PATH?.trim();
if (override) {
  const executable = path.resolve(override);
  if (!fs.existsSync(executable)) {
    throw new Error(`CODEX_WEB_ELECTRON_PATH does not exist: ${executable}`);
  }
  process.stderr.write(`Using external Electron executable: ${executable}\n`);
  process.exit(0);
}

const electronPackagePath = require.resolve("electron/package.json", {
  paths: [projectRoot],
});
const electronRoot = path.dirname(electronPackagePath);
const electronPackage = JSON.parse(
  fs.readFileSync(electronPackagePath, "utf8"),
);
if (electronPackage.version !== expectedVersion) {
  throw new Error(
    `Electron package mismatch: expected ${expectedVersion}, got ${electronPackage.version}.`,
  );
}

function resolveInstalledExecutable() {
  const pathFile = path.join(electronRoot, "path.txt");
  if (!fs.existsSync(pathFile)) return null;
  const executableName = fs.readFileSync(pathFile, "utf8").trim();
  if (!executableName) return null;
  const executable = path.join(electronRoot, "dist", executableName);
  return fs.existsSync(executable) ? executable : null;
}

let executable = resolveInstalledExecutable();
if (!executable) {
  if (process.env.CODEX_WEB_SKIP_ELECTRON_RUNTIME === "1") {
    process.stderr.write(
      "Skipping Electron executable installation because CODEX_WEB_SKIP_ELECTRON_RUNTIME=1.\n",
    );
    process.exit(0);
  }

  const environment = { ...process.env };
  if (proxy) {
    environment.ELECTRON_GET_USE_PROXY = "1";
    environment.HTTP_PROXY = proxy;
    environment.HTTPS_PROXY = proxy;
  }
  const installScript = path.join(electronRoot, "install.js");
  const result = spawnSync(process.execPath, [installScript], {
    cwd: electronRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  executable = resolveInstalledExecutable();
}

if (!executable) {
  throw new Error(
    `Electron ${expectedVersion} completed installation without an executable.`,
  );
}
process.stderr.write(`Electron ${expectedVersion} runtime: ${executable}\n`);
