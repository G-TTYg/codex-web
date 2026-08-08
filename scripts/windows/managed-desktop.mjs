#!/usr/bin/env node

/**
 * Resolves and downloads the architecture-specific, repository-pinned Windows
 * Desktop MSIX. Package signature, identity, and extraction remain owned by
 * setup.ps1 because those checks use Windows package APIs.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadVerified } from "../managed-download.mjs";

const windowsScriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(windowsScriptsRoot, "..", "..");
const manifestPath = path.join(projectRoot, "scripts", "runtime-versions.json");

async function readManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export async function getWindowsDesktopDescriptor({
  arch = process.arch,
} = {}) {
  const manifest = await readManifest();
  const desktop = manifest.windowsDesktop;
  const artifact = desktop.artifacts?.[arch];
  if (!artifact) {
    throw new Error(`Unsupported Windows Desktop architecture: ${arch}`);
  }
  if (
    !artifact.url ||
    !artifact.integrity ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    !artifact.fileName
  ) {
    throw new Error(
      `Incomplete Windows Desktop artifact metadata for ${arch}.`,
    );
  }
  return {
    arch,
    archivePath: path.join(
      projectRoot,
      "scratch",
      "downloads",
      artifact.fileName,
    ),
    artifact,
    packageIdentity: desktop.packageIdentity,
    packagePublisher: desktop.packagePublisher,
    packageVersion: desktop.packageVersion,
  };
}

export async function prepareWindowsDesktop({
  arch = process.arch,
  proxy = process.env.CODEX_WEB_DOWNLOAD_PROXY ?? "",
} = {}) {
  if (process.platform !== "win32") {
    throw new Error("The managed Windows Desktop source requires Windows.");
  }
  const descriptor = await getWindowsDesktopDescriptor({ arch });
  await downloadVerified({
    ...descriptor.artifact,
    destination: descriptor.archivePath,
    proxy,
  });
  return descriptor.archivePath;
}

function parseCliArgs(args) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (new Set(["--arch", "--proxy"]).has(value)) {
      const next = args[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      options[value.slice(2)] = next;
      index += 1;
    } else {
      positionals.push(value);
    }
  }
  return { options, positionals };
}

async function main() {
  const { options, positionals } = parseCliArgs(process.argv.slice(2));
  const command = positionals[0] ?? "prepare";
  const descriptorOptions = { arch: options.arch };
  if (command === "describe") {
    process.stdout.write(
      `${JSON.stringify(await getWindowsDesktopDescriptor(descriptorOptions))}\n`,
    );
    return;
  }
  if (command !== "prepare") {
    throw new Error(`Unsupported managed Desktop command: ${command}`);
  }
  const archivePath = await prepareWindowsDesktop({
    ...descriptorOptions,
    proxy: options.proxy,
  });
  process.stdout.write(`${archivePath}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
