import fs from "node:fs/promises";
import path from "node:path";

export const RENDERER_BUILD_REVISION_PATH = "assets/build-revision.json";

const UNCACHED_RENDERER_FILES = new Set([
  "index.html",
  "assets/preload.js",
  RENDERER_BUILD_REVISION_PATH,
]);

export function parseRendererBuildRevision(contents: string): string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch (error) {
    throw new Error("Renderer build revision manifest is not valid JSON", {
      cause: error,
    });
  }

  const revision =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "revision")
      : undefined;
  if (
    typeof revision !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(revision)
  ) {
    throw new Error("Renderer build revision manifest is missing a revision");
  }

  return revision;
}

export async function readRendererBuildRevision(
  webviewRoot: string,
): Promise<string> {
  const contents = await fs.readFile(
    path.join(webviewRoot, RENDERER_BUILD_REVISION_PATH),
    "utf8",
  );
  return parseRendererBuildRevision(contents);
}

export function shouldDisableRendererAssetCache(
  webviewRoot: string,
  filePath: string,
): boolean {
  const relativePath = path
    .relative(webviewRoot, filePath)
    .split(path.sep)
    .join("/");
  return UNCACHED_RENDERER_FILES.has(relativePath);
}
