#!/usr/bin/env node

/**
 * Downloads repository-pinned artifacts into ignored project state.
 * Callers own artifact-specific trust checks; this module enforces only the
 * manifest byte length and SRI digest and never discovers newer versions.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export function parseIntegrity(integrity) {
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

export async function hashFile(filePath, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function hasExpectedArtifact(filePath, { integrity, size }) {
  if (!(await pathExists(filePath))) return false;
  const fileStats = await stat(filePath);
  if (!fileStats.isFile() || (size != null && fileStats.size !== size)) {
    return false;
  }
  const { algorithm, expected } = parseIntegrity(integrity);
  return (await hashFile(filePath, algorithm)) === expected;
}

function runCurl({ url, destination, proxy, resume }) {
  const args = [];
  if (proxy) args.push("--proxy", proxy);
  args.push("--fail", "--location", "--retry", "3", "--progress-bar");
  if (resume) args.push("--continue-at", "-");
  args.push("--output", destination, url);
  const result = spawnSync("curl", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export async function downloadVerified({
  url,
  integrity,
  size,
  destination,
  proxy = process.env.CODEX_WEB_DOWNLOAD_PROXY ?? "",
}) {
  const contract = { integrity, size };
  if (await hasExpectedArtifact(destination, contract)) {
    process.stderr.write(`Using verified cached download: ${destination}\n`);
    return;
  }
  await rm(destination, { force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  const partialStats = await stat(partial).catch(() => null);
  let resumed = Boolean(partialStats?.isFile() && partialStats.size > 0);
  let status = runCurl({ url, destination: partial, proxy, resume: resumed });
  if (status !== 0 && resumed) {
    process.stderr.write("Resume was rejected; restarting the download.\n");
    await rm(partial, { force: true });
    resumed = false;
    status = runCurl({ url, destination: partial, proxy, resume: false });
  }
  if (status !== 0) {
    throw new Error(`Download failed with curl exit code ${status}: ${url}`);
  }
  if (!(await hasExpectedArtifact(partial, contract)) && resumed) {
    process.stderr.write(
      "Resumed download failed integrity; retrying from the beginning.\n",
    );
    await rm(partial, { force: true });
    status = runCurl({ url, destination: partial, proxy, resume: false });
    if (status !== 0) {
      throw new Error(`Download failed with curl exit code ${status}: ${url}`);
    }
  }
  if (!(await hasExpectedArtifact(partial, contract))) {
    await rm(partial, { force: true });
    throw new Error(
      `Downloaded artifact failed its size or integrity check: ${url}`,
    );
  }
  await rename(partial, destination);
}
