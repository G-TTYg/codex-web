/**
 * Cross-platform Tailscale discovery for the public server launcher. Tailscale
 * is optional: discovery errors are reported to callers so --prefer-tailscale
 * can fail closed without changing the ordinary loopback default.
 */
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { isIPv4 } from "node:net";
import path from "node:path";

async function resolveTailscaleCommand(explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    await access(resolved);
    return resolved;
  }

  for (const candidate of ["tailscale", "tailscale.exe"]) {
    const result = spawnSync(candidate, ["version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return candidate;
  }

  return null;
}

export function buildTailscaleStatusArguments(socket) {
  return [...(socket ? [`--socket=${socket}`] : []), "status", "--json"];
}

export function parseTailscaleStatus(
  status,
  { ipv4Override = "", dnsNameOverride = "" } = {},
) {
  const self = status?.Self;
  const ipv4 = ipv4Override || self?.TailscaleIPs?.find(isIPv4) || "";
  if (ipv4Override && !isIPv4(ipv4Override)) {
    throw new Error("--tailscale-ipv4 must be a valid IPv4 address.");
  }

  return {
    available: Boolean(self?.Online),
    dnsName: (dnsNameOverride || self?.DNSName || "").replace(/\.$/u, ""),
    hostName: self?.HostName || "",
    ipv4,
  };
}

export async function getTailscaleInfo({
  commandPath = "",
  socket = "",
  ipv4Override = "",
  dnsNameOverride = "",
} = {}) {
  let command;
  try {
    command = await resolveTailscaleCommand(commandPath);
  } catch (error) {
    return { available: false, error: error.message };
  }

  if (!command) {
    return {
      available: false,
      error:
        "Could not find the Tailscale CLI. Pass --tailscale-path /path/to/tailscale.",
    };
  }

  const result = spawnSync(command, buildTailscaleStatusArguments(socket), {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) {
    return { available: false, command, error: result.error.message };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return {
      available: false,
      command,
      error: `tailscale status failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`,
    };
  }

  try {
    return {
      command,
      ...parseTailscaleStatus(JSON.parse(result.stdout), {
        ipv4Override,
        dnsNameOverride,
      }),
    };
  } catch (error) {
    return { available: false, command, error: error.message };
  }
}

export function serverLinks({ host, port, tailscaleInfo }) {
  const links = [];
  if (new Set(["127.0.0.1", "localhost", "0.0.0.0"]).has(host)) {
    links.push(["Local", `http://127.0.0.1:${port}/`]);
  }
  if (
    tailscaleInfo?.available &&
    tailscaleInfo.ipv4 &&
    new Set([tailscaleInfo.ipv4, "0.0.0.0"]).has(host)
  ) {
    links.push(["Tailnet", `http://${tailscaleInfo.ipv4}:${port}/`]);
    if (tailscaleInfo.dnsName) {
      links.push(["MagicDNS", `http://${tailscaleInfo.dnsName}:${port}/`]);
    }
  }
  return links;
}
