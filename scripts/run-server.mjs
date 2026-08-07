#!/usr/bin/env node

/** Launch the server with the pinned managed CLI unless explicitly overridden. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveManagedCodex } from "./managed-runtime.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverEntry = path.join(projectRoot, "src", "server", "main.js");
const codexPath =
  process.env.CODEX_CLI_PATH ||
  (await resolveManagedCodex({ prepareIfMissing: true }));

process.stderr.write(`Using Codex CLI: ${codexPath}\n`);
const child = spawn(process.execPath, [serverEntry, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: { ...process.env, CODEX_CLI_PATH: codexPath },
  stdio: "inherit",
});

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
