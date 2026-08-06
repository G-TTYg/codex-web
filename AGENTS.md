# Repository guidance

## Scope and purpose

- The project root is this repository; it is not a monorepo.
- `codex-web` exposes the Codex Desktop renderer in a browser while the Codex
  process and filesystem access remain on a user-controlled host.
- Supported hosts are macOS, Linux, and Windows. Keep the browser/server
  protocol shared; isolate platform-specific Desktop discovery and extraction
  in build tooling.

## Read before changing behavior

1. `README.md`
2. `ARCHITECTURE.md`
3. `UPGRADING.md`
4. The relevant files under `src/` and `scripts/`
5. The latest entry under `logs/` when continuing upgrade work

## Project map

- `src/browser/` implements the renderer-side Electron and browser shims.
- `src/server/` hosts static assets and bridges renderer IPC to the Desktop
  shell/app-server code.
- `scripts/` discovers, extracts, validates, and patches official Desktop
  bundles.
- `scripts/patch-desktop-asar.mjs` is the single shared, fail-closed semantic
  patch implementation for all hosts.
- `assets/` contains project-owned PWA assets copied into generated webviews.
- `scratch/` and compiled JavaScript under `src/server/` are generated and must
  not be committed.

## Desktop version invariants

- Treat macOS Sparkle version, Windows Appx version, extracted ASAR version,
  Electron version, and Codex CLI version as independent values.
- Keep default runtime versions and official artifact integrity values in
  `scripts/runtime-versions.json`. Windows must not silently replace a pinned
  Appx or CLI with the newest locally installed version.
- Use only official OpenAI Desktop distributions as extraction sources.
- Validate ASAR metadata before patching. Never silently continue after an
  expected semantic anchor or patch hunk is missing or ambiguous.
- Prefer semantic anchors over fingerprinted chunk names. Update and verify the
  shared semantic patcher when Desktop changes.
- Do not commit extracted OpenAI application code or locally installed Appx
  content.

## Commands

- Dependency install without lifecycle build: `npm ci --ignore-scripts`
- Server typecheck/build: `npm run build:server`
- Full platform-aware generated build: `npm run build`
- Unix-only Desktop extraction: `npm run prepare:asar`
- Windows setup: `./setup-windows.ps1`

## Architecture and code rules

- Keep the renderer shim, IPC transport, Desktop shell shim, and platform build
  adapters separate. Platform discovery must not leak into runtime IPC code.
- Keep public browser/server message shapes backward-compatible unless an
  upstream Desktop protocol change requires an explicit migration.
- Avoid new dependencies unless existing Node APIs or current dependencies
  cannot provide the required behavior.
- Add comments for non-obvious external constraints, fail-closed patch checks,
  and version compatibility rules; do not narrate obvious syntax.

## Git and documentation rules

- Default branch: `main`. Agent feature branches use the `codex/` prefix.
- Check `git status --short --branch` before edits and before handoff. Stage
  explicit paths and keep generated artifacts out of commits.
- Stable setup and compatibility facts belong in `README.md`,
  `UPGRADING.md`, or `ARCHITECTURE.md`; decisions belong in `DECISIONS.md` or
  `docs/adr/`; process notes belong in `logs/YYYY-MM-DD.md`.
- For non-trivial completed work, make a local verified commit. Do not push or
  publish without the user's request.

## Verification

- Run narrow script/unit checks first, then server typecheck and the applicable
  platform build.
- Desktop upgrades require metadata validation and at least one successful
  extraction/patch/build path. State clearly which host platforms were not
  exercised locally.
- Never weaken a failing patch assertion merely to make a newer bundle build.
