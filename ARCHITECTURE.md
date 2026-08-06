# Architecture

`codex-web` reuses the official Codex Desktop renderer while replacing the
Electron window boundary with a browser/server bridge. Official application
code is extracted at install time and is not stored in this repository.

## Build-time flow

```mermaid
flowchart LR
  W["Windows Store app.asar"] --> E["Selective ASAR extractor"]
  U["Official macOS Desktop zip"] --> E
  E --> M["Metadata validation"]
  M --> P["Shared fail-closed semantic patcher"]
  P --> V["Vite browser preload build"]
  P --> S["TypeScript server build"]
  V --> O["Generated scratch/asar tree"]
  S --> O
```

Windows discovers the newest installed `OpenAI.Codex` Appx package in
`setup-windows.ps1`. macOS and Linux download the pinned official macOS zip, or
consume `HOSTED_CODEX_APP_ZIP` when supplied. Both paths converge on:

- `scripts/extract-needed-asar.mjs`, which extracts only the Desktop package
  metadata, compiled shell bundles, webview, skills, and native-menu locales;
- `scripts/patch-desktop-asar.mjs`, which validates the ChatGPT brand and applies
  every browser compatibility change through unique semantic anchors;
- `scripts/generate-pwa-icon.mjs`, which creates the browser install icon; and
- the shared browser and server builds.

Selective extraction intentionally omits upstream native modules. The Desktop
shell only leaves `better-sqlite3` external in the supported bundle, and the
project supplies a host-native build of that dependency.

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
sidebar state, file/workspace selection, and local file URLs. The server shim
owns privileged host behavior such as filesystem access and launching the Codex
app-server. Platform-specific Appx/zip discovery never enters this runtime IPC
layer.

## Version contracts

These values must not be conflated:

- macOS Sparkle release version;
- Windows Appx package version;
- `version` inside the extracted ASAR;
- Electron version inside the ASAR package metadata; and
- Codex CLI version.

The ASAR version identifies renderer compatibility. Both browser and server
Electron shims read the extracted package metadata rather than relying on a
second hard-coded value. Windows prints every layer during setup.

## Patch policy

The former fingerprinted unified diffs were removed. Current Desktop releases
coalesce many modules into large fingerprinted chunks, making filename- and
format-sensitive diffs brittle across platforms. The shared semantic patcher:

1. locates a bundle using multiple independent behavior anchors;
2. requires exactly one match for each transformation;
3. recognizes an already-patched target; and
4. aborts on missing or ambiguous contracts.

Do not loosen an assertion merely to accept a new Desktop version. Inspect the
upstream behavior, update the anchor and transformation together, then exercise
the affected UI flow.

The rationale is recorded in
[`docs/adr/2026-08-06-shared-semantic-desktop-patcher.md`](./docs/adr/2026-08-06-shared-semantic-desktop-patcher.md).

## Generated and packaged files

- `scratch/desktop-source/`: temporary Unix zip extraction.
- `scratch/chatgpt-desktop.asar`: copied Windows source ASAR.
- `scratch/asar/`: patched package content shipped by npm/Nix.
- `src/server/**/*.js`: generated server output.

All are ignored by Git. The npm package includes only the patched extracted tree
and compiled server files, not the original Desktop archive.
