#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

function parseArgs(argv) {
  const options = {
    asarPath: null,
    outDir: "scratch/asar",
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--asar") {
      options.asarPath = argv[++i];
    } else if (arg === "--out") {
      options.outDir = argv[++i];
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

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/extract-needed-asar.mjs --asar <app.asar> [--out scratch/asar] [--force]

Extracts only the ChatGPT Desktop files codex-web needs. The same extracted
layout is used on macOS, Linux, and Windows, and avoids failures when an archive
references platform-specific unpacked native files.`);
}

function normalizeArchivePath(entry) {
  return entry.replace(/^[/\\]+/, "");
}

function shouldExtract(entry) {
  const comparable = entry.replaceAll("\\", "/");
  return (
    comparable === "package.json" ||
    comparable.startsWith(".vite/build/") ||
    comparable.startsWith("webview/") ||
    comparable.startsWith("skills/") ||
    comparable.startsWith("native-menu-locales/")
  );
}

async function extractFile(asarPath, outDir, archivePath) {
  const parts = archivePath.split(/[\\/]+/u);
  const destination = path.join(outDir, ...parts);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const contents = asar.extractFile(asarPath, archivePath);
  await fs.writeFile(destination, contents);
}

async function main() {
  const { asarPath, outDir, force } = parseArgs(process.argv.slice(2));
  const resolvedAsar = path.resolve(asarPath);
  const resolvedOut = path.resolve(outDir);

  if (force) {
    await fs.rm(resolvedOut, { recursive: true, force: true });
  }

  await fs.mkdir(resolvedOut, { recursive: true });

  const entries = asar
    .listPackage(resolvedAsar)
    .map(normalizeArchivePath)
    .filter(shouldExtract)
    .sort();

  let extracted = 0;
  let directories = 0;

  for (const archivePath of entries) {
    const stat = asar.statFile(resolvedAsar, archivePath);
    if (stat.files) {
      directories += 1;
      continue;
    }
    await extractFile(resolvedAsar, resolvedOut, archivePath);
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
