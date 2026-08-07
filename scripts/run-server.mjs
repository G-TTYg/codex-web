#!/usr/bin/env node

/**
 * Cross-platform public server entry point. It resolves the pinned Codex CLI,
 * applies the same host/Tailscale policy on every OS, then launches the
 * compiled server with only its supported host and port arguments.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveManagedCodex } from "./managed-runtime.mjs";
import { getTailscaleInfo, serverLinks } from "./tailscale.mjs";

const valueOptions = new Map([
  ["--host", "host"],
  ["--port", "port"],
  ["--tailscale-path", "tailscalePath"],
  ["--tailscale-socket", "tailscaleSocket"],
  ["--tailscale-ipv4", "tailscaleIPv4"],
  ["--tailscale-dns-name", "tailscaleDNSName"],
]);

function printHelp() {
  process.stdout.write(`Usage:
  codex-web [--host <host>] [--port <port>] [Tailscale options]

Defaults:
  --host 127.0.0.1
  --port 8214

Tailscale options:
  --prefer-tailscale          Bind to the detected Tailnet IPv4 address
  --tailscale-path <path>     Use a non-default Tailscale CLI
  --tailscale-socket <path>   Pass a non-default tailscaled socket
  --tailscale-ipv4 <address>  Override the detected Tailnet IPv4 address
  --tailscale-dns-name <name> Override the detected MagicDNS name

Examples:
  npm run server -- --port 9000
  npm run server -- --prefer-tailscale
  npm run server -- --host 0.0.0.0
`);
}

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

function parseArguments(argv) {
  const options = {
    host: "",
    port: 8214,
    preferTailscale: false,
    tailscalePath: "",
    tailscaleSocket: "",
    tailscaleIPv4: "",
    tailscaleDNSName: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--prefer-tailscale") {
      options.preferTailscale = true;
      continue;
    }
    const property = valueOptions.get(argument);
    if (!property) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    options[property] = property === "port" ? parsePort(value) : value;
  }

  if (options.preferTailscale && options.host) {
    throw new Error("--prefer-tailscale cannot be combined with --host.");
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const tailscaleRequested =
  options.preferTailscale ||
  options.tailscalePath ||
  options.tailscaleSocket ||
  options.tailscaleIPv4 ||
  options.tailscaleDNSName;
const tailscaleInfo = tailscaleRequested
  ? await getTailscaleInfo({
      commandPath: options.tailscalePath,
      socket: options.tailscaleSocket,
      ipv4Override: options.tailscaleIPv4,
      dnsNameOverride: options.tailscaleDNSName,
    })
  : null;

if (options.preferTailscale && !tailscaleInfo?.available) {
  throw new Error(
    `--prefer-tailscale was requested, but a usable Tailnet address was not found. ${tailscaleInfo?.error || "Tailscale is offline or has no IPv4 address."}`,
  );
}
if (options.preferTailscale && !tailscaleInfo.ipv4) {
  throw new Error(
    "--prefer-tailscale was requested, but Tailscale has no IPv4 address.",
  );
}

const host = options.preferTailscale
  ? tailscaleInfo.ipv4
  : options.host || "127.0.0.1";
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverEntry = path.join(projectRoot, "src", "server", "main.js");
const codexPath =
  process.env.CODEX_CLI_PATH ||
  (await resolveManagedCodex({ prepareIfMissing: true }));

process.stderr.write(`Using Codex CLI: ${codexPath}\n`);
process.stderr.write(`Listening on ${host}:${options.port}\n`);
for (const [label, url] of serverLinks({
  host,
  port: options.port,
  tailscaleInfo,
})) {
  process.stderr.write(`${label.padEnd(9)} ${url}\n`);
}

const child = spawn(
  process.execPath,
  [serverEntry, "--host", host, "--port", String(options.port)],
  {
    cwd: projectRoot,
    env: { ...process.env, CODEX_CLI_PATH: codexPath },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
