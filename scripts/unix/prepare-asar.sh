#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${HOSTED_CODEX_APP_ZIP:-}" ]]; then
  echo "HOSTED_CODEX_APP_ZIP must point to an official ChatGPT Desktop zip." >&2
  exit 1
fi

SOURCE_DIR="scratch/desktop-source"
ASAR_ROOT="scratch/asar"

rm -rf "$SOURCE_DIR" "$ASAR_ROOT"
mkdir -p "$SOURCE_DIR"
unzip -q -o "$HOSTED_CODEX_APP_ZIP" -d "$SOURCE_DIR"

ASAR_PATH="$SOURCE_DIR/ChatGPT.app/Contents/Resources/app.asar"
RESOURCES_PATH="$SOURCE_DIR/ChatGPT.app/Contents/Resources"
ASAR_UNPACKED_PATH="$RESOURCES_PATH/app.asar.unpacked"
if [[ ! -f "$ASAR_PATH" ]]; then
  echo "Could not find ChatGPT.app/Contents/Resources/app.asar in $HOSTED_CODEX_APP_ZIP" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) TARGET_PLATFORM="darwin" ;;
  Linux) TARGET_PLATFORM="linux" ;;
  *)
    echo "Unsupported Unix host: $(uname -s)" >&2
    exit 1
    ;;
esac

node ./scripts/extract-needed-asar.mjs \
  --asar "$ASAR_PATH" \
  --unpacked-root "$ASAR_UNPACKED_PATH" \
  --platform "$TARGET_PLATFORM" \
  --out "$ASAR_ROOT" \
  --force
node ./scripts/copy-desktop-resources.mjs \
  --resources "$RESOURCES_PATH" \
  --platform "$TARGET_PLATFORM" \
  --out "$ASAR_ROOT"
cp assets/* "$ASAR_ROOT/webview/"

PWA_SOURCE_ICON="$(find "$ASAR_ROOT/webview/assets" -maxdepth 1 -type f -name 'app-*.png' | sort | head -n 1)"
if [[ -z "$PWA_SOURCE_ICON" ]]; then
  echo "Could not find a Desktop app icon under $ASAR_ROOT/webview/assets" >&2
  exit 1
fi

node ./scripts/generate-pwa-icon.mjs \
  "$PWA_SOURCE_ICON" \
  "$ASAR_ROOT/webview/assets/pwa-icon-512.png"
node ./scripts/patch-desktop-asar.mjs --root "$ASAR_ROOT"
node ./scripts/audit-runtime-externals.mjs \
  --root "$ASAR_ROOT" \
  --platform "$TARGET_PLATFORM"
