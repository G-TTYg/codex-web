#!/usr/bin/env node

/**
 * Cross-platform manager for the repository-pinned Codex CLI. It deliberately
 * stores official archives and extracted runtimes under ignored project state,
 * verifies npm SRI metadata, and never selects a different CLI from PATH.
 */
import { access, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadVerified } from "./managed-download.mjs";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptsRoot);
const manifestPath = path.join(scriptsRoot, "runtime-versions.json");

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  return result;
}

async function findCodexExecutable(root, platform) {
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const pending = [root];
  const matches = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (
        entry.isFile() &&
        entry.name === executableName &&
        path.basename(path.dirname(entryPath)) === "bin"
      ) {
        matches.push(entryPath);
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${executableName} in ${root}, found ${matches.length}.`,
    );
  }
  return matches[0];
}

function verifyVersion(executable, expectedVersion) {
  const result = run(executable, ["--version"], { capture: true });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const match = output.match(/codex-cli\s+([^\s]+)/);
  if (!match || match[1] !== expectedVersion) {
    throw new Error(
      `Pinned Codex CLI version mismatch. Expected ${expectedVersion}, got: ${output}`,
    );
  }
}

export async function getRuntimeDescriptor({
  platform = process.platform,
  arch = process.arch,
  runtimeDirectory = process.env.CODEX_WEB_RUNTIME_DIR,
} = {}) {
  const manifest = await readManifest();
  const artifact = manifest.codexCli.artifacts?.[platform]?.[arch];
  if (!artifact) {
    throw new Error(`Unsupported Codex CLI platform: ${platform}-${arch}`);
  }
  const managedRoot = runtimeDirectory
    ? path.resolve(runtimeDirectory)
    : path.join(projectRoot, "scratch", "runtime");
  const runtimeRoot = path.join(
    managedRoot,
    "codex",
    manifest.codexCli.version,
    `${platform}-${arch}`,
  );
  const archiveName = `codex-${manifest.codexCli.version}-${platform}-${arch}.tgz`;
  return {
    arch,
    artifact,
    archivePath: path.join(projectRoot, "scratch", "downloads", archiveName),
    expectedVersion: manifest.codexCli.version,
    platform,
    runtimeRoot,
  };
}

export async function resolveManagedCodex({
  prepareIfMissing = false,
  proxy = process.env.CODEX_WEB_DOWNLOAD_PROXY ?? "",
  ...descriptorOptions
} = {}) {
  const descriptor = await getRuntimeDescriptor(descriptorOptions);
  if (await pathExists(descriptor.runtimeRoot)) {
    try {
      const existing = await findCodexExecutable(
        descriptor.runtimeRoot,
        descriptor.platform,
      );
      verifyVersion(existing, descriptor.expectedVersion);
      return existing;
    } catch (error) {
      if (!prepareIfMissing) throw error;
    }
  } else if (!prepareIfMissing) {
    throw new Error(
      `Pinned Codex runtime is missing: ${descriptor.runtimeRoot}`,
    );
  }

  await downloadVerified({
    url: descriptor.artifact.url,
    integrity: descriptor.artifact.integrity,
    destination: descriptor.archivePath,
    proxy,
  });
  await rm(descriptor.runtimeRoot, { recursive: true, force: true });
  await mkdir(path.dirname(descriptor.runtimeRoot), { recursive: true });
  const staging = `${descriptor.runtimeRoot}.staging-${process.pid}-${Date.now()}`;
  await mkdir(staging, { recursive: true });
  try {
    const extraction = run("tar", [
      "-xzf",
      descriptor.archivePath,
      "-C",
      staging,
    ]);
    if (extraction.status !== 0) {
      throw new Error(
        `Extracting the pinned Codex CLI failed with exit code ${extraction.status}.`,
      );
    }
    const stagedExecutable = await findCodexExecutable(
      staging,
      descriptor.platform,
    );
    verifyVersion(stagedExecutable, descriptor.expectedVersion);
    await rename(staging, descriptor.runtimeRoot);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const executable = await findCodexExecutable(
    descriptor.runtimeRoot,
    descriptor.platform,
  );
  verifyVersion(executable, descriptor.expectedVersion);
  return executable;
}

function parseCliArgs(args) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (new Set(["--platform", "--arch", "--proxy"]).has(value)) {
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
  const descriptorOptions = {
    platform: options.platform,
    arch: options.arch,
  };
  if (command === "describe") {
    process.stdout.write(
      `${JSON.stringify(await getRuntimeDescriptor(descriptorOptions))}\n`,
    );
    return;
  }
  const executable = await resolveManagedCodex({
    ...descriptorOptions,
    prepareIfMissing: command === "prepare",
    proxy: options.proxy,
  });
  process.stdout.write(`${executable}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
