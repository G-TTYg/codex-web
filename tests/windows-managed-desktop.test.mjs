import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  hasExpectedArtifact,
  parseIntegrity,
} from "../scripts/managed-download.mjs";
import { getWindowsDesktopDescriptor } from "../scripts/windows/managed-desktop.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("Windows Desktop descriptors pin both Store architectures", async () => {
  const x64 = await getWindowsDesktopDescriptor({ arch: "x64" });
  const arm64 = await getWindowsDesktopDescriptor({ arch: "arm64" });

  assert.equal(x64.packageIdentity, "OpenAI.Codex");
  assert.equal(x64.packagePublisher, "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B");
  assert.equal(x64.packageVersion, "26.730.8199.0");
  assert.equal(x64.artifact.size, 740803123);
  assert.equal(
    x64.artifact.integrity,
    "sha256-omoC6kgDl8Pn6PAMOt6roloYFmvVKvVWZkRaYWLpqXQ=",
  );
  assert.match(x64.artifact.url, /codex-app-26\.730\.61639/);
  assert.match(x64.archivePath, /26\.730\.8199\.0_x64/);

  assert.equal(arm64.packageVersion, x64.packageVersion);
  assert.equal(arm64.artifact.size, 735962198);
  assert.equal(
    arm64.artifact.integrity,
    "sha256-glRyerKf\/+TY\/p2J2DLSVTH2EqmvJzwHkimAnxj\+ZCQ=",
  );
  assert.match(arm64.artifact.url, /codex-app-26\.730\.61639/);
  assert.match(arm64.archivePath, /26\.730\.8199\.0_arm64/);
});

test("Windows Desktop descriptor rejects unpinned architectures", async () => {
  await assert.rejects(
    getWindowsDesktopDescriptor({ arch: "ia32" }),
    /Unsupported Windows Desktop architecture/,
  );
});

test("managed download integrity requires both exact bytes and digest", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-web-download-"));
  const fixture = path.join(tempRoot, "artifact.bin");
  try {
    const bytes = Buffer.from("pinned-artifact-fixture");
    await writeFile(fixture, bytes);
    const digest = createHash("sha256").update(bytes).digest("base64");
    const integrity = `sha256-${digest}`;

    assert.deepEqual(parseIntegrity(integrity), {
      algorithm: "sha256",
      expected: createHash("sha256").update(bytes).digest("hex"),
    });
    assert.equal(
      await hasExpectedArtifact(fixture, { integrity, size: bytes.length }),
      true,
    );
    assert.equal(
      await hasExpectedArtifact(fixture, {
        integrity,
        size: bytes.length + 1,
      }),
      false,
    );
    assert.equal(
      await hasExpectedArtifact(fixture, {
        integrity: `sha256-${Buffer.alloc(32).toString("base64")}`,
        size: bytes.length,
      }),
      false,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Windows source adapter keeps all package checks fail-closed", () => {
  const helper = readFileSync(
    path.join(projectRoot, "scripts", "windows", "desktop-source.ps1"),
    "utf8",
  );
  const setup = readFileSync(
    path.join(projectRoot, "scripts", "windows", "setup.ps1"),
    "utf8",
  );
  for (const contract of [
    "Get-AuthenticodeSignature",
    "Get-FileHash",
    "Assert-AppxIdentity",
    "AppxBlockMap.xml",
    "AppxSignature.p7x",
    "unsafe archive path",
    "UnescapeDataString",
    "extractionFormat",
  ]) {
    assert.match(
      helper,
      new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(
    setup,
    /Pinned .* is not installed; preparing its verified managed MSIX/,
  );
  assert.match(setup, /-UseNewestInstalledDesktop/);
  assert.match(helper, /process\.arch/);
  assert.match(
    setup,
    /Architecture\)\.ToLowerInvariant\(\) -eq \$buildArchitecture/,
  );
  const explicitSource = setup.indexOf('Source = "explicit"');
  const installedSource = setup.indexOf("Source = $package.PackageFullName");
  const managedSource = setup.indexOf("return Resolve-ManagedDesktopPackage");
  assert.ok(explicitSource >= 0);
  assert.ok(installedSource > explicitSource);
  assert.ok(managedSource > installedSource);
});

test(
  "PowerShell parses the Windows adapters",
  { skip: process.platform !== "win32" },
  () => {
    for (const relativePath of [
      "scripts/windows/desktop-source.ps1",
      "scripts/windows/setup.ps1",
    ]) {
      const scriptPath = path.join(projectRoot, relativePath);
      const command = [
        "$tokens=$null",
        "$errors=$null",
        `[System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors) | Out-Null`,
        "if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }",
      ].join("; ");
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", command],
        {
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  },
);

test(
  "cached pinned MSIX passes Windows signature and Appx identity validation",
  { skip: process.platform !== "win32" },
  async (context) => {
    const descriptor = await getWindowsDesktopDescriptor({ arch: "x64" });
    if (!existsSync(descriptor.archivePath)) {
      context.skip("pinned x64 MSIX is not cached");
      return;
    }
    const command = [
      `. '${path.join(projectRoot, "scripts", "windows", "desktop-source.ps1").replaceAll("'", "''")}'`,
      `$d = node '${path.join(projectRoot, "scripts", "windows", "managed-desktop.mjs").replaceAll("'", "''")}' describe --arch x64 | ConvertFrom-Json`,
      "$null = Assert-ManagedDesktopArchive -ArchivePath $d.archivePath -Descriptor $d",
    ].join("; ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", command],
      {
        encoding: "utf8",
        cwd: projectRoot,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
);
