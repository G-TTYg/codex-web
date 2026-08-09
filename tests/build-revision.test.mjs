import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

let moduleSequence = 0;

async function loadTypeScriptModule(relativePath) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path.basename(sourceUrl.pathname),
  });
  moduleSequence += 1;
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${moduleSequence}`);
}

test("browser reloads once when the server serves a different build", async () => {
  const { createBuildRevisionGuard } = await loadTypeScriptModule(
    "../src/browser/build-revision.ts",
  );
  let reloads = 0;
  const handle = createBuildRevisionGuard("browser-a", () => {
    reloads += 1;
  });

  assert.equal(handle({ type: "unrelated" }), false);
  assert.equal(
    handle({ type: "server-build-revision", revision: "browser-a" }),
    true,
  );
  assert.equal(reloads, 0);
  assert.equal(
    handle({ type: "server-build-revision", revision: "server-b" }),
    true,
  );
  assert.equal(
    handle({ type: "server-build-revision", revision: "server-c" }),
    true,
  );
  assert.equal(reloads, 1);
});

test("renderer revision manifest and cache policy fail closed", async () => {
  const { parseRendererBuildRevision, shouldDisableRendererAssetCache } =
    await loadTypeScriptModule("../src/server/renderer-build.ts");
  const root = path.resolve("renderer-root");

  assert.equal(
    parseRendererBuildRevision('{"revision":"build-123"}'),
    "build-123",
  );
  assert.throws(() => parseRendererBuildRevision("not json"), /valid JSON/);
  assert.throws(
    () => parseRendererBuildRevision('{"revision":"../escape"}'),
    /missing a revision/,
  );
  assert.equal(
    shouldDisableRendererAssetCache(root, path.join(root, "index.html")),
    true,
  );
  assert.equal(
    shouldDisableRendererAssetCache(
      root,
      path.join(root, "assets", "preload.js"),
    ),
    true,
  );
  assert.equal(
    shouldDisableRendererAssetCache(
      root,
      path.join(root, "assets", "app-hashed.js"),
    ),
    false,
  );
});
