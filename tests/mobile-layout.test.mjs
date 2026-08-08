import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = new URL("../src/browser/mobile-layout.ts", import.meta.url);

test("phone drawers use project-owned opaque theme fills", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /\$\{MOBILE_LAYOUT_SELECTOR\} \{[\s\S]*--codex-web-phone-left-drawer-background: #f9f9f9;[\s\S]*--codex-web-phone-right-drawer-background: #fff;[\s\S]*\}/,
  );
  assert.match(
    source,
    /\$\{MOBILE_LAYOUT_SELECTOR\}\.electron-dark \{[\s\S]*--codex-web-phone-left-drawer-background: #000;[\s\S]*--codex-web-phone-right-drawer-background: #181818;[\s\S]*\}/,
  );
  assert.match(
    source,
    /\$\{MOBILE_LAYOUT_SELECTOR\} aside\.app-shell-left-panel \{[\s\S]*background: var\(--codex-web-phone-left-drawer-background\) !important;/,
  );
  assert.match(
    source,
    /\$\{MOBILE_LAYOUT_SELECTOR\} aside\[data-app-shell-focus-area="right-panel"\] \{[\s\S]*background: var\(--codex-web-phone-right-drawer-background\) !important;/,
  );

  assert.doesNotMatch(source, /\bCanvas\b/);
  assert.doesNotMatch(source, /--color-background-surface(?:-under)?/);
});
