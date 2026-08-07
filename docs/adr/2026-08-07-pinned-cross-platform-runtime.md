# Pin the default cross-platform runtime independently from local Codex

## Status

Accepted on 2026-08-07. This expands the initial Windows-only decision to the
ordinary macOS and Linux npm/Git workflows.

## Context

The launch paths previously selected a local Codex CLI: Windows chose the
highest version found in the Desktop runtime or `PATH`, while macOS/Linux
required users to supply `CODEX_CLI_PATH`. A working checkout could therefore
change behavior after unrelated local updates, and each platform followed a
different runtime contract.

## Decision

- Keep Desktop, Windows Appx, Electron, Codex CLI, official URL, and integrity
  defaults in `scripts/runtime-versions.json`.
- Use `scripts/managed-runtime.mjs` on Windows, macOS, and Linux to select the
  official artifact for the host OS/architecture, validate its npm SRI
  SHA-512 value, extract it below ignored project state, and verify the exact
  CLI version.
- Route the npm binary and `npm run server` through `scripts/run-server.mjs`,
  which prepares the managed CLI when missing.
- Require the manifest's exact installed Windows Appx by default. Newer Appx
  packages are tested only through an explicit setup override because the
  Microsoft Store does not expose a reproducible historical-version URL.
- Keep `CODEX_CLI_PATH`, Windows `-CodexPath`, and Desktop source switches as
  explicit escape hatches.
- Do not override `CODEX_HOME`; the independent executable continues to share
  the user's normal authentication, configuration, and data directories.

## Consequences

The ordinary three-platform workflows use one pinned CLI version and one
acquisition/verification contract instead of silently following a host CLI.
Initial setup downloads a large platform archive. Nix continues to fetch the
same manifest artifact declaratively and wraps the server with its store path.
Native execution still must be tested on each OS/architecture before release.
