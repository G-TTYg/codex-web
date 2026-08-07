#!/usr/bin/env node

/**
 * Fail-closed audit for dependencies intentionally externalized by Desktop.
 * The checked manifest is an explicit compatibility contract: an upstream
 * addition, a removed provider, or a missing native resource stops the build.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { builtinModules, createRequire } from "node:module";
import ts from "typescript";

const scriptRequire = createRequire(import.meta.url);
const manifestPath = new URL("./runtime-externals.json", import.meta.url);

function parseArgs(argv) {
  const options = {
    arch: process.arch,
    root: "scratch/asar",
    platform: process.platform,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = argv[++index];
    else if (argument === "--platform") options.platform = argv[++index];
    else if (argument === "--arch") options.arch = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["darwin", "linux", "win32"].includes(options.platform)) {
    throw new Error(`Unsupported --platform value: ${options.platform}`);
  }
  return options;
}

function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

function containsCreateRequire(node) {
  if (
    (ts.isIdentifier(node) && node.text === "createRequire") ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "createRequire")
  ) {
    return true;
  }
  return node.getChildren().some(containsCreateRequire);
}

function packageName(specifier) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:") ||
    specifier.includes("\\")
  ) {
    return null;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.length >= 2
      ? `${segments[0]}/${segments[1]}`
      : null
    : segments[0];
}

function inspectSource(sourceText, fileName) {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const requireAliases = new Set();
  const modules = new Set();
  const nativeLiterals = new Set();

  function findAliases(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      containsCreateRequire(node.initializer.expression)
    ) {
      requireAliases.add(node.name.text);
    }
    ts.forEachChild(node, findAliases);
  }
  findAliases(source);

  function recordModule(specifier) {
    const name = packageName(specifier);
    if (
      name &&
      !name.startsWith("node:") &&
      !builtinModules.includes(name) &&
      !builtinModules.includes(specifier)
    ) {
      modules.add(name);
    }
  }

  function visit(node) {
    const text = literalText(node);
    if (text?.endsWith(".node")) nativeLiterals.add(text);

    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const specifier = literalText(node.arguments[0]);
      if (specifier) {
        const callee = node.expression;
        const directRequire =
          (ts.isIdentifier(callee) &&
            (callee.text === "require" || requireAliases.has(callee.text))) ||
          callee.kind === ts.SyntaxKind.ImportKeyword;
        const requireResolve =
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "resolve" &&
          ts.isIdentifier(callee.expression) &&
          requireAliases.has(callee.expression.text);
        const immediateCreateRequire =
          ts.isCallExpression(callee) &&
          containsCreateRequire(callee.expression);
        if (directRequire || requireResolve || immediateCreateRequire) {
          recordModule(specifier);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { modules, nativeLiterals };
}

function compareSets(label, actual, expected) {
  const unexpected = [...actual].filter((item) => !expected.has(item)).sort();
  const missing = [...expected].filter((item) => !actual.has(item)).sort();
  if (unexpected.length || missing.length) {
    throw new Error(
      `${label} compatibility manifest is stale.` +
        `${unexpected.length ? ` Unexpected: ${unexpected.join(", ")}.` : ""}` +
        `${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}`,
    );
  }
}

async function assertPath(target, kind = "file") {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    throw new Error(`Required runtime ${kind} is missing: ${target}`, {
      cause: error,
    });
  }
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`Required runtime ${kind} has the wrong type: ${target}`);
  }
}

function resolveModule(entry, bundleRequire) {
  if (entry.provider === "server-shim") return "server Electron shim";
  if (entry.provider === "project") return scriptRequire.resolve(entry.name);
  if (entry.provider === "extracted") return bundleRequire.resolve(entry.name);
  if (entry.provider === "nested") {
    let nestedRequire = bundleRequire;
    for (const dependency of entry.via ?? []) {
      nestedRequire = createRequire(nestedRequire.resolve(dependency));
    }
    return nestedRequire.resolve(entry.name);
  }
  throw new Error(`Unknown provider ${entry.provider} for ${entry.name}.`);
}

async function auditComputerUse(root, arch, contract) {
  if (!contract.required) return;
  const runtimeRoot = path.join(root, "cua_node");
  const runtimeManifestPath = path.join(runtimeRoot, "manifest.json");
  await assertPath(runtimeManifestPath);
  const runtimeManifest = JSON.parse(
    await fs.readFile(runtimeManifestPath, "utf8"),
  );
  if (runtimeManifest.platform !== contract.manifestPlatform) {
    throw new Error(
      `Computer Use runtime platform mismatch: expected ${contract.manifestPlatform}, got ${runtimeManifest.platform}.`,
    );
  }
  if (runtimeManifest.arch !== arch) {
    throw new Error(
      `Computer Use runtime architecture mismatch: expected ${arch}, got ${runtimeManifest.arch}.`,
    );
  }
  await assertPath(path.join(runtimeRoot, runtimeManifest.node_path));
  await assertPath(path.join(runtimeRoot, runtimeManifest.node_repl_path));
  const moduleRoot = path.join(runtimeRoot, runtimeManifest.node_modules);
  await assertPath(moduleRoot, "directory");
  await assertPath(path.join(moduleRoot, "@oai", "sky", "package.json"));
  console.log(
    `Computer Use runtime: ${runtimeManifest.target} ${runtimeManifest.runtime_archive_version}`,
  );
}

async function readResolvedPackage(modulePath, expectedName) {
  let directory = path.dirname(modulePath);
  for (;;) {
    const candidate = path.join(directory, "package.json");
    try {
      const packageJson = JSON.parse(await fs.readFile(candidate, "utf8"));
      if (packageJson.name === expectedName) return packageJson;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not locate package.json for ${expectedName}.`);
}

async function auditWorkLouder(bundleRequire, contract) {
  const deviceKitPath = bundleRequire.resolve("@worklouder/device-kit-oai");
  const deviceKitPackage = await readResolvedPackage(
    deviceKitPath,
    "@worklouder/device-kit-oai",
  );
  const deviceKitRequire = createRequire(deviceKitPath);
  const wlDeviceKitPath = deviceKitRequire.resolve("@worklouder/wl-device-kit");
  const wlDeviceKitPackage = await readResolvedPackage(
    wlDeviceKitPath,
    "@worklouder/wl-device-kit",
  );
  const wlDeviceKitRequire = createRequire(wlDeviceKitPath);
  const nodeHidPath = wlDeviceKitRequire.resolve("node-hid");
  const nodeHidPackage = await readResolvedPackage(nodeHidPath, "node-hid");
  const serialportPath = wlDeviceKitRequire.resolve("serialport");
  const serialportPackage = await readResolvedPackage(
    serialportPath,
    "serialport",
  );

  const versions = [
    [
      "@worklouder/device-kit-oai",
      deviceKitPackage.version,
      contract.deviceKitVersion,
    ],
    [
      "@worklouder/wl-device-kit",
      wlDeviceKitPackage.version,
      contract.wlDeviceKitVersion,
    ],
    ["node-hid", nodeHidPackage.version, contract.nodeHidVersion],
    ["serialport", serialportPackage.version, contract.serialportVersion],
  ];
  for (const [name, actual, expected] of versions) {
    if (actual !== expected) {
      throw new Error(
        `${name} version mismatch: expected ${expected}, got ${actual}.`,
      );
    }
  }

  const deviceKit = bundleRequire("@worklouder/device-kit-oai");
  const nodeHid = wlDeviceKitRequire("node-hid");
  const serialport = wlDeviceKitRequire("serialport");
  if (deviceKit.DeviceType?.CodexMicro == null) {
    throw new Error(
      "Work Louder device kit does not export CodexMicro support.",
    );
  }
  if (typeof nodeHid.devicesAsync !== "function") {
    throw new Error("node-hid does not export devicesAsync().");
  }
  if (typeof serialport.SerialPort !== "function") {
    throw new Error("serialport does not export SerialPort.");
  }
  console.log(
    `Work Louder runtime: device-kit-oai ${deviceKitPackage.version}, wl-device-kit ${wlDeviceKitPackage.version}, node-hid ${nodeHidPackage.version}, serialport ${serialportPackage.version}`,
  );
}

async function main() {
  const {
    arch,
    root: rootArgument,
    platform,
  } = parseArgs(process.argv.slice(2));
  const root = path.resolve(rootArgument);
  const buildRoot = path.join(root, ".vite", "build");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `Unsupported runtime externals schema ${manifest.schemaVersion}.`,
    );
  }

  const files = (await fs.readdir(buildRoot))
    .filter((file) => file.endsWith(".js"))
    .sort();
  const modules = new Set();
  const nativeLiterals = new Set();
  for (const file of files) {
    const inspected = inspectSource(
      await fs.readFile(path.join(buildRoot, file), "utf8"),
      file,
    );
    inspected.modules.forEach((module) => modules.add(module));
    inspected.nativeLiterals.forEach((literal) => nativeLiterals.add(literal));
  }

  const expectedModules = new Set(
    manifest.dynamicModules.map((entry) => entry.name),
  );
  compareSets("Dynamic module", modules, expectedModules);
  compareSets(
    "Native resource literal",
    nativeLiterals,
    new Set(manifest.nativeResourceLiterals),
  );

  const bundleRequire = createRequire(path.join(buildRoot, "audit-entry.cjs"));
  for (const entry of manifest.dynamicModules) {
    if (!entry.platforms.includes(platform)) continue;
    const resolved = resolveModule(entry, bundleRequire);
    console.log(`Resolved ${entry.name} via ${entry.provider}: ${resolved}`);
  }

  for (const file of manifest.nativeResources[platform]) {
    await assertPath(path.join(root, "native", file));
  }
  await auditWorkLouder(bundleRequire, manifest.workLouder);
  await auditComputerUse(root, arch, manifest.computerUseRuntime[platform]);
  console.log(`Runtime external audit passed for ${platform}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
