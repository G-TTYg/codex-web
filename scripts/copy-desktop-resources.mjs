#!/usr/bin/env node

/**
 * Copies only the official out-of-ASAR runtime trees used by the Desktop shell.
 * Linux intentionally has no copy path because no official Linux Desktop
 * distribution exists; its browser and Codex Micro paths use host dependencies.
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    arch: process.arch,
    resourcesRoot: null,
    outDir: "scratch/asar",
    platform: process.platform,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--resources") {
      options.resourcesRoot = argv[++index];
    } else if (argument === "--arch") {
      options.arch = argv[++index];
    } else if (argument === "--out") {
      options.outDir = argv[++index];
    } else if (argument === "--platform") {
      options.platform = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!["darwin", "linux", "win32"].includes(options.platform)) {
    throw new Error(`Unsupported --platform value: ${options.platform}`);
  }
  if (options.platform !== "linux" && !options.resourcesRoot) {
    throw new Error("Missing required --resources path.");
  }
  return options;
}

async function copyTree(source, destination) {
  try {
    const stat = await fs.stat(source);
    if (!stat.isDirectory()) throw new Error("source is not a directory");
  } catch (error) {
    throw new Error(
      `Required Desktop resource directory is missing: ${source}`,
      {
        cause: error,
      },
    );
  }
  await fs.rm(destination, { force: true, recursive: true });
  await fs.cp(source, destination, {
    dereference: false,
    errorOnExist: false,
    force: true,
    preserveTimestamps: true,
    recursive: true,
  });
}

async function main() {
  const { arch, resourcesRoot, outDir, platform } = parseArgs(
    process.argv.slice(2),
  );
  const output = path.resolve(outDir);

  if (platform === "linux") {
    await fs.rm(path.join(output, "native"), { force: true, recursive: true });
    await fs.rm(path.join(output, "cua_node"), {
      force: true,
      recursive: true,
    });
    console.log(
      "Skipped Desktop native and Computer Use resources on Linux (no official Linux Desktop source).",
    );
    return;
  }

  const resources = path.resolve(resourcesRoot);
  const computerUseManifest = JSON.parse(
    await fs.readFile(
      path.join(resources, "cua_node", "manifest.json"),
      "utf8",
    ),
  );
  const expectedManifestPlatform = platform === "win32" ? "windows" : platform;
  if (
    computerUseManifest.platform !== expectedManifestPlatform ||
    computerUseManifest.arch !== arch
  ) {
    throw new Error(
      `Desktop Resources target ${computerUseManifest.platform}-${computerUseManifest.arch} does not match ${expectedManifestPlatform}-${arch}.`,
    );
  }
  await copyTree(path.join(resources, "native"), path.join(output, "native"));
  await copyTree(
    path.join(resources, "cua_node"),
    path.join(output, "cua_node"),
  );
  console.log(
    `Copied Desktop native and Computer Use resources from ${resources}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
