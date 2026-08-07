#!/usr/bin/env node

/**
 * Cross-platform manager for the repository-pinned Codex CLI. It deliberately
 * stores official archives and extracted runtimes under ignored project state,
 * verifies npm SRI metadata, and never selects a different CLI from PATH.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function parseIntegrity(integrity) {
  const separator = integrity.indexOf("-");
  if (separator <= 0 || separator === integrity.length - 1) {
    throw new Error(`Invalid SRI integrity value: ${integrity}`);
  }
  const algorithm = integrity.slice(0, separator).toLowerCase();
  if (!new Set(["sha256", "sha512"]).has(algorithm)) {
    throw new Error(`Unsupported integrity algorithm: ${algorithm}`);
  }
  return {
    algorithm,
    expected: Buffer.from(integrity.slice(separator + 1), "base64").toString(
      "hex",
    ),
  };
}

async function hashFile(filePath, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function hasExpectedIntegrity(filePath, integrity) {
  if (!(await pathExists(filePath))) return false;
  const { algorithm, expected } = parseIntegrity(integrity);
  return (await hashFile(filePath, algorithm)) === expected;
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

function curlDownload({ url, destination, proxy, resume }) {
  const args = [];
  if (proxy) args.push("--proxy", proxy);
  args.push("--fail", "--location", "--retry", "3", "--progress-bar");
  if (resume) args.push("--continue-at", "-");
  args.push("--output", destination, url);
  return run("curl", args).status ?? 1;
}

async function downloadVerified({ url, integrity, destination, proxy }) {
  if (await hasExpectedIntegrity(destination, integrity)) {
    process.stderr.write(`Using verified cached download: ${destination}\n`);
    return;
  }
  await rm(destination, { force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  const partialStats = await stat(partial).catch(() => null);
  let resumed = Boolean(partialStats?.isFile() && partialStats.size > 0);
  let status = curlDownload({
    url,
    destination: partial,
    proxy,
    resume: resumed,
  });
  if (status !== 0 && resumed) {
    process.stderr.write("Resume was rejected; restarting the download.\n");
    await rm(partial, { force: true });
    resumed = false;
    status = curlDownload({ url, destination: partial, proxy, resume: false });
  }
  if (status !== 0) {
    throw new Error(`Download failed with curl exit code ${status}: ${url}`);
  }
  if (!(await hasExpectedIntegrity(partial, integrity)) && resumed) {
    process.stderr.write(
      "Resumed download failed integrity; retrying from the beginning.\n",
    );
    await rm(partial, { force: true });
    status = curlDownload({ url, destination: partial, proxy, resume: false });
    if (status !== 0) {
      throw new Error(`Download failed with curl exit code ${status}: ${url}`);
    }
  }
  if (!(await hasExpectedIntegrity(partial, integrity))) {
    await rm(partial, { force: true });
    throw new Error(`Downloaded artifact failed its integrity check: ${url}`);
  }
  await rename(partial, destination);
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
