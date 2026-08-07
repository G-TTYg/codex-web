# Upgrading Codex Desktop

Desktop upgrades are compatibility migrations, not version-string-only changes.
The semantic patcher must either apply every expected behavior exactly once or
stop the build.

## 1. Record every version layer

Check the official macOS appcast and Windows Store package independently. On
Windows, run `setup-windows.ps1` with `-UseNewestInstalledDesktop`,
`-SkipPinnedCli`, and `-SkipInstall` to print Appx, ASAR, brand, and Electron
metadata. Also record the official npm metadata for each supported platform
CLI artifact.

Create a `codex/` feature branch and add the discoveries, source URLs, and test
matrix to the dated project log before changing compatibility code.

## 2. Update pinned sources

Update:

- Desktop, Windows Appx, Electron, CLI versions, URLs, and integrity values for
  all supported OS/architecture pairs in `scripts/runtime-versions.json`;
- the project Electron development dependency when ASAR metadata changes; and
- the per-platform Nix CLI hashes when the pinned CLI changes.

The Homebrew `chatgpt` cask is a useful independent source for official macOS
zip versions and SHA-256 values. Convert the hex digest to an SRI hash or run
`nix hash file` against the downloaded archive. npm registry integrity values
can be used directly as SRI hashes for the platform Codex CLI tarballs. The
shared runtime manager supports macOS, Linux, and Windows x64/arm64 descriptors
and rejects a download whose SRI value differs from the manifest.

Do not assume the Windows Appx version equals the version inside `app.asar`, or
that Windows and macOS ASAR files with the same internal version are byte- or
minifier-identical.

## 3. Extract an unmodified comparison tree

Keep the last known-good generated tree outside `scratch/asar`, then extract the
new source without patching it. The shared extractor is platform-neutral:

```bash
node scripts/extract-needed-asar.mjs \
  --asar /absolute/path/to/app.asar \
  --out scratch/asar-new-unpatched \
  --force
```

On Windows, pass an explicit source to the setup script after the patcher has
been updated:

```powershell
.\setup-windows.ps1 -AppAsarPath C:\path\to\app.asar -SkipInstall
```

Never commit the extracted trees or official archive.

## 4. Port semantic transformations

Run the patcher against the unmodified tree:

```bash
node scripts/patch-desktop-asar.mjs --root scratch/asar-new-unpatched
```

For each failed assertion:

1. identify the upstream module by behavior, not its fingerprinted filename;
2. compare the old and new implementation around the failed contract;
3. update both discovery anchors and the smallest required transformation;
4. retain the exactly-one-match check; and
5. document any changed behavior or tradeoff.

When Windows and macOS publish different builds under the same ASAR version,
run the patcher against both pristine sources. If only minified identifiers
differ, keep the verified forms as alternatives inside the same transformation;
do not fork the behavior or create a second platform patcher.

The current transforms cover routing/history, mobile sidebar behavior,
ProseMirror touch input, local file URLs, Statsig network isolation, URL prompt
prefill, browser titles, PWA/preload markup, and Sentry disablement in renderer,
worker, and shell bundles.

## 5. Verify by increasing scope

Run the host-specific complete build:

```bash
npm ci --ignore-scripts
npm run build
```

```powershell
.\setup-windows.ps1
```

Then verify:

- metadata and brand validation succeeded;
- every semantic transform reported success with no skipped assertion;
- browser and server builds completed;
- the server starts and `/` plus the WebSocket endpoint are reachable;
- existing and new tasks render;
- prompt prefill and browser navigation work;
- mobile sidebar and touch composer behavior work;
- file/workspace pickers and inline images work; and
- subagent/app-host MessagePort traffic still works.

Exercise Windows natively and at least one Unix build path before release. If a
macOS or Linux runtime is unavailable, report that limitation explicitly; a
successful shared ASAR build is not a native runtime test.

On every available native host, move the ignored
`scratch/runtime/codex/<old-version>` directory out of the way and run the
default build/start workflow. Confirm it downloads the pinned CLI for the host
architecture, verifies the archive, reports the exact version, and starts
without consulting a newer `codex` on `PATH`.

## 6. Close the upgrade

Update the compatibility table in `README.md`, architecture/docs when contracts
changed, the ADR for a new cross-cutting decision, and the dated process log.
Review `git diff`, check for extracted proprietary files or credentials, stage
only intentional paths, and create a local verified commit before publishing.
