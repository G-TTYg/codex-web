#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

function parseArgs(argv) {
  const options = {
    asarPath: null,
    unpackedRoot: null,
    outDir: "scratch/asar",
    platform: process.platform,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--asar") {
      options.asarPath = argv[++i];
    } else if (arg === "--unpacked-root") {
      options.unpackedRoot = argv[++i];
    } else if (arg === "--out") {
      options.outDir = argv[++i];
    } else if (arg === "--platform") {
      options.platform = argv[++i];
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.asarPath) {
    throw new Error("Missing required --asar path.");
  }
  if (!["darwin", "linux", "win32"].includes(options.platform)) {
    throw new Error(`Unsupported --platform value: ${options.platform}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/extract-needed-asar.mjs --asar <app.asar> \
    [--unpacked-root <app.asar.unpacked>] [--platform <platform>] \
    [--out scratch/asar] [--force]

Extracts only the ChatGPT Desktop files codex-web needs. The same extracted
layout is used on macOS, Linux, and Windows. Selected private packages preserve
their official ASAR layout, while host-owned native modules remain excluded.`);
}

function normalizeArchivePath(entry) {
  return entry.replace(/^[/\\]+/, "");
}

function shouldExtract(entry, platform) {
  const comparable = entry.replaceAll("\\", "/");
  const workLouderRoot = "node_modules/@worklouder/device-kit-oai/";
  const isWorkLouder = comparable.startsWith(workLouderRoot);
  const isHostOwnedNativePackage =
    isWorkLouder &&
    [
      "/node_modules/node-hid/",
      "/node_modules/serialport/",
      "/node_modules/@serialport/",
    ].some((segment) => comparable.includes(segment));

  return (
    comparable === "package.json" ||
    comparable.startsWith(".vite/build/") ||
    comparable.startsWith("webview/") ||
    comparable.startsWith("skills/") ||
    comparable.startsWith("native-menu-locales/") ||
    (isWorkLouder && !isHostOwnedNativePackage) ||
    (platform === "darwin" && comparable.startsWith("node_modules/objc-js/"))
  );
}

async function extractFile(asarPath, unpackedRoot, outDir, archivePath, stat) {
  const parts = archivePath.split(/[\\/]+/u);
  const destination = path.join(outDir, ...parts);
  await fs.mkdir(path.dirname(destination), { recursive: true });

  if (stat.unpacked) {
    if (!unpackedRoot) {
      throw new Error(
        `Selected ASAR entry ${archivePath} is unpacked, but --unpacked-root was not supplied.`,
      );
    }
    const source = path.join(unpackedRoot, ...parts);
    try {
      await fs.copyFile(source, destination);
    } catch (error) {
      throw new Error(
        `Could not copy selected unpacked ASAR entry ${archivePath} from ${source}.`,
        { cause: error },
      );
    }
    return;
  }

  const contents = asar.extractFile(asarPath, archivePath);
  await fs.writeFile(destination, contents);
}

async function main() {
  const { asarPath, unpackedRoot, outDir, platform, force } = parseArgs(
    process.argv.slice(2),
  );
  const resolvedAsar = path.resolve(asarPath);
  const resolvedUnpacked = unpackedRoot ? path.resolve(unpackedRoot) : null;
  const resolvedOut = path.resolve(outDir);

  if (force) {
    await fs.rm(resolvedOut, { recursive: true, force: true });
  }

  await fs.mkdir(resolvedOut, { recursive: true });

  const entries = asar
    .listPackage(resolvedAsar)
    .map(normalizeArchivePath)
    .filter((entry) => shouldExtract(entry, platform))
    .sort();

  let extracted = 0;
  let directories = 0;

  for (const archivePath of entries) {
    const stat = asar.statFile(resolvedAsar, archivePath);
    if (stat.files) {
      directories += 1;
      continue;
    }
    await extractFile(
      resolvedAsar,
      resolvedUnpacked,
      resolvedOut,
      archivePath,
      stat,
    );
    extracted += 1;
  }

  console.log(
    `Extracted ${extracted} files and skipped ${directories} directory entries into ${resolvedOut}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
