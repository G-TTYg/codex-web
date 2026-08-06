# Pin the default Windows runtime independently from local Codex

## Status

Accepted on 2026-08-07.

## Context

The Windows launcher previously selected the highest Codex CLI found in the
Desktop runtime or `PATH`, while setup selected the newest installed Store
package. This made a working codex-web checkout change behavior after unrelated
local Codex updates and allowed the renderer and app-server contract to drift.

## Decision

- Keep Desktop, Windows Appx, Electron, and Codex CLI defaults in
  `scripts/runtime-versions.json`.
- Require the manifest's exact installed Windows Appx by default. Newer Appx
  packages are tested only through an explicit setup override.
- Download the architecture-specific Windows CLI from the official npm
  registry into ignored project storage and verify its SRI SHA-512 value.
- Launch that project-local CLI by default. Keep `-AppAsarPath`,
  `-UseNewestInstalledDesktop`, and `-CodexPath` as explicit escape hatches.
- Do not override `CODEX_HOME`; the independent executable continues to share
  the user's normal authentication, configuration, and data directories.

## Consequences

Windows behavior is reproducible and does not silently follow a local CLI or
Store update. Initial setup downloads a large platform CLI archive and requires
the pinned Store package to remain installed. A Desktop or CLI upgrade is now
an intentional manifest change with integrity and end-to-end verification.
