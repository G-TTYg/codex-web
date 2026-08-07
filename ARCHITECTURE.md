# Architecture

`codex-web` reuses the official Codex Desktop renderer while replacing the
Electron window boundary with a browser/server bridge. Official application
code is extracted at install time and is not stored in this repository.

## Build-time flow

```mermaid
flowchart LR
  W["Pinned Windows Store app.asar"] --> E["Selective ASAR extractor"]
  U["Official macOS Desktop zip"] --> E
  W --> R["Official Resources copier"]
  U --> R
  E --> M["Metadata validation"]
  R --> A["Fail-closed runtime audit"]
  M --> P["Shared fail-closed semantic patcher"]
  P --> A
  A --> V["Vite browser preload build"]
  A --> S["TypeScript server build"]
  V --> O["Generated scratch/asar tree"]
  S --> O
```

Windows selects the exact installed `OpenAI.Codex` Appx package recorded in
`scripts/runtime-versions.json`; newer local Store packages are used only by an
explicit override. macOS and Linux download the pinned official macOS zip, or
consume `HOSTED_CODEX_APP_ZIP` when supplied. Both paths converge on:

- `scripts/windows/setup.ps1` and `scripts/unix/*.sh`, the platform-specific
  source acquisition adapters behind the shared `npm run build` entry;
- `scripts/extract-needed-asar.mjs`, which extracts the Desktop package
  metadata, compiled shell bundles, webview, skills, native-menu locales, the
  private Work Louder device kit, and macOS `objc-js` support while preserving
  selected `app.asar.unpacked` entries;
- `scripts/copy-desktop-resources.mjs`, which copies the matching official
  `native/` and standalone `cua_node/` runtime on Windows and macOS;
- `scripts/audit-runtime-externals.mjs` and
  `scripts/runtime-externals.json`, which fail the build when a dynamic module,
  native resource literal, provider, native asset, or Computer Use runtime
  contract is added, removed, unresolved, or targets the wrong platform;
- `scripts/patch-desktop-asar.mjs`, which validates the ChatGPT brand and applies
  every browser compatibility change through unique semantic anchors;
- `scripts/generate-pwa-icon.mjs`, which creates the browser install icon; and
- the shared browser and server builds.

Selective extraction intentionally replaces upstream copies of
`better-sqlite3`, `node-pty`, `node-hid`, and SerialPort bindings with
project-owned host builds. This keeps database, terminal, HID, and serial
addons compatible with the Node runtime that hosts the browser bridge instead
of loading Electron-targeted binaries from an Appx or macOS bundle. The private
Work Louder JavaScript stays sourced from the official Desktop distribution;
the semantic patch makes host Node use `node-hid` discovery and the existing
polling fallback rather than the Electron-only HID topology watcher.

Windows and macOS retain the official `native/` tree as an audited Desktop
asset and copy the complete `cua_node/` standalone runtime. `cua_node` is
validated against its manifest, host architecture, executable paths, module
tree, and `@oai/sky` package. Native addons linked directly to Electron are not
treated as plain-Node providers: runtime paths continue to use upstream guards
and fallbacks. Linux has no official native Resources source, so its build
skips both trees explicitly; Codex Micro still uses host dependencies, while
native Computer Use remains unsupported there.

## Runtime flow

The official renderer expects a preload script and Electron IPC. Vite bundles
the upstream preload together with `src/browser/shim.ts`, which provides the
small Electron-compatible surface needed in a normal browser.

Renderer IPC is serialized over a WebSocket to `src/server/main.ts`. The server
loads the official Desktop main bundle after installing the module alias in
`src/server/module.ts`; imports of `electron` resolve to the host-side shim in
`src/server/electron/`. The existing MessagePort/app-host forwarding is kept so
subagents and newer Desktop protocol paths continue to work.

The browser shim handles local browser concerns such as history mapping, mobile
sidebar state, touch interaction fallbacks, file/workspace selection, and local
file URLs. On narrow viewports and portrait touch tablets up to 1024 CSS pixels,
`src/browser/mobile-layout.ts` turns the Desktop left and right sidebars into
opaque overlay drawers, preserves the renderer's application-menu/header
layout, and owns outside-tap dismissal. Capability-based media queries keep
desktop Edge device emulation and iPad browsers on the same layout path without
changing ordinary mouse-driven tablet-width windows.
Outside-tap dismissal observes the real underlying target after a complete
click and does not consume its pointer sequence, so links and controls remain
first-tap operable while a drawer is open.
`src/browser/mobile-interactions.ts` owns a separate mobile interaction layer
instead of emulating Desktop gestures. The semantic patcher marks renderer
context-menu owners; the browser layer adds one portal-based action button per
visible target and collects hover-only controls into a touch-sized bottom
sheet. Renderer-owned pointer menus use the same bottom-sheet presentation.
The portal buttons listen only for completed clicks and permit `pan-y`, so a
normal pointer sequence remains native scrolling or the row's primary action.
The shared semantic patcher removes Radix touch long-press menus, disables the
file tree's custom touch-drag activator, and makes dnd-kit's PointerSensor reject
every non-mouse pointer without consuming its event. HTML drag starts are also
cancelled while touch is the active input. Hardware mouse right click and mouse
drag remain Desktop-owned on hybrid devices.
Mobile search surfaces remain mounted when software-keyboard dismissal blurs
their input. The server shim
owns privileged host behavior such as filesystem access and launching the
Codex app-server. Terminal creation remains in the official Desktop shell and
resolves the project-owned `node-pty` installation through Node's normal module
lookup. Platform-specific Appx/zip discovery never enters this runtime IPC
layer.

On every ordinary host, `scripts/managed-runtime.mjs` chooses the pinned Codex
CLI artifact by OS and architecture, validates its npm SRI SHA-512 value, and
extracts it below `scratch/runtime/`. `scripts/run-server.mjs` is both the npm
binary and server entry point; it prepares the runtime when missing and then
sets `CODEX_CLI_PATH` for the compiled server. It also owns the shared host,
port, and optional Tailscale discovery arguments on every platform. The Windows
build adapter uses the same runtime manager. Explicit `CODEX_CLI_PATH` values
remain overrides. No `CODEX_HOME` override is applied, so the managed executable
shares the host's normal account, configuration, and data directories.

Nix reads the same manifest artifacts but preserves reproducibility by fetching
the CLI into the Nix store and wrapping `codex-web` with that store path. Runtime
download caches and extracted binaries are never included in npm packages.

## Version contracts

These values must not be conflated:

- macOS Sparkle release version;
- Windows Appx package version;
- `version` inside the extracted ASAR;
- Electron version inside the ASAR package metadata; and
- Codex CLI version.

The ASAR version identifies renderer compatibility. Both browser and server
Electron shims read the extracted package metadata rather than relying on a
second hard-coded value. Windows prints every layer during setup. Default
versions and download integrity values are centralized in
`scripts/runtime-versions.json`; Nix reads the same Desktop and CLI versions.

## Patch policy

The former fingerprinted unified diffs were removed. Current Desktop releases
coalesce many modules into large fingerprinted chunks, making filename- and
format-sensitive diffs brittle across platforms. The shared semantic patcher:

1. locates a bundle using multiple independent behavior anchors;
2. requires exactly one match for each transformation;
3. recognizes an already-patched target; and
4. aborts on missing or ambiguous contracts.

The renderer's JavaScript TextMate engine is pinned to its ES2018 output target
at patch time. This prevents it from emitting ES2025 inline regular-expression
modifier groups that are not yet accepted by all Safari/WebKit versions while
preserving syntax highlighting on newer browsers.

Do not loosen an assertion merely to accept a new Desktop version. Inspect the
upstream behavior, update the anchor and transformation together, then exercise
the affected UI flow.

## Generated and packaged files

- `scratch/desktop-source/`: temporary Unix zip extraction.
- `scratch/chatgpt-desktop.asar`: copied Windows source ASAR.
- `scratch/asar/`: patched package content shipped by npm/Nix.
- `src/server/**/*.js`: generated server output.

All are ignored by Git. The npm package includes only the patched extracted tree
and compiled server files, not the original Desktop archive.
