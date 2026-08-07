param(
  [string]$AppVersion = "",
  [string]$AppAsarPath = "",
  [string]$AppAsarUnpackedPath = "",
  [string]$AppResourcesPath = "",
  [string]$DownloadProxy = "",
  [switch]$UseNewestInstalledDesktop,
  [switch]$SkipPinnedCli,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).ProviderPath
Set-Location -LiteralPath $projectRoot

$setupLockHashBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))
$setupLockHash = -join ($setupLockHashBytes | ForEach-Object { $_.ToString("x2") })
$setupMutex = [System.Threading.Mutex]::new($false, "Global\codex-web-setup-$setupLockHash")
$setupHasMutex = $false

try {
  $setupHasMutex = $setupMutex.WaitOne()
} catch [System.Threading.AbandonedMutexException] {
  $setupHasMutex = $true
}

function Resolve-RequiredCommand {
  param(
    [string[]]$Names,
    [string]$ErrorMessage
  )

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }

  throw $ErrorMessage
}

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Action
  )

  Write-Host ""
  Write-Host "== $Name =="
  & $Action
}

function Invoke-NativeCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$Name
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE."
  }
}

function Assert-FileNotLocked {
  param(
    [string]$Path,
    [string]$ErrorMessage
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  try {
    $stream = [System.IO.File]::Open(
      (Resolve-Path -LiteralPath $Path).ProviderPath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::None
    )
    $stream.Dispose()
  } catch {
    throw "$ErrorMessage`nLocked file: $Path"
  }
}

function Resolve-ChatGPTDesktopAsar {
  param(
    [string]$RequestedVersion,
    [string]$ExplicitAsarPath,
    [string]$ExplicitUnpackedPath,
    [string]$ExplicitResourcesPath,
    [bool]$UseNewest,
    [object]$Manifest
  )

  if ($ExplicitAsarPath) {
    if (-not (Test-Path -LiteralPath $ExplicitAsarPath)) {
      throw "Could not find app.asar at $ExplicitAsarPath."
    }

    $resolvedAsarPath = (Resolve-Path -LiteralPath $ExplicitAsarPath).ProviderPath
    $resourcesPath = if ($ExplicitResourcesPath) {
      if (-not (Test-Path -LiteralPath $ExplicitResourcesPath -PathType Container)) {
        throw "Could not find Desktop Resources at $ExplicitResourcesPath."
      }
      (Resolve-Path -LiteralPath $ExplicitResourcesPath).ProviderPath
    } else {
      Split-Path -Parent $resolvedAsarPath
    }
    $unpackedPath = if ($ExplicitUnpackedPath) {
      if (-not (Test-Path -LiteralPath $ExplicitUnpackedPath -PathType Container)) {
        throw "Could not find app.asar.unpacked at $ExplicitUnpackedPath."
      }
      (Resolve-Path -LiteralPath $ExplicitUnpackedPath).ProviderPath
    } else {
      Join-Path $resourcesPath "app.asar.unpacked"
    }

    return @{
      Identity = "n/a (explicit ASAR)"
      PackageVersion = "n/a (explicit ASAR)"
      Path = $resolvedAsarPath
      ResourcesPath = $resourcesPath
      UnpackedPath = $unpackedPath
      Source = "explicit"
    }
  }

  # The ChatGPT-branded Codex workspace app currently keeps the historical
  # OpenAI.Codex Store identity. Validate the actual brand from ASAR metadata.
  $packageIdentity = [string]$Manifest.windowsDesktop.packageIdentity
  $packages = @(Get-AppxPackage -Name $packageIdentity -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Version } -Descending)

  $effectiveVersion = $RequestedVersion
  if (-not $UseNewest -and -not $effectiveVersion) {
    $effectiveVersion = [string]$Manifest.windowsDesktop.packageVersion
  }
  if ($effectiveVersion) {
    $packages = @($packages | Where-Object { [string]$_.Version -eq $effectiveVersion })
    if ($packages.Count -eq 0) {
      throw "Could not find installed $packageIdentity version $effectiveVersion. Install that pinned Microsoft Store version, pass -AppAsarPath, or explicitly use -UseNewestInstalledDesktop."
    }
  }

  foreach ($package in $packages) {
    foreach ($relativePath in @("app\resources\app.asar", "resources\app.asar")) {
      $candidate = Join-Path $package.InstallLocation $relativePath
      if (Test-Path -LiteralPath $candidate) {
        return @{
          Identity = [string]$package.Name
          PackageVersion = [string]$package.Version
          Path = $candidate
          ResourcesPath = Split-Path -Parent $candidate
          UnpackedPath = Join-Path (Split-Path -Parent $candidate) "app.asar.unpacked"
          Source = $package.PackageFullName
        }
      }
    }
  }

  throw "Could not find an installed ChatGPT Desktop app.asar. Install the pinned Microsoft Store package or pass -AppAsarPath explicitly."
}

function Resolve-PwaSourceIcon {
  param([string]$AssetsPath)

  $preferred = Join-Path $AssetsPath "app-D0g8sCle.png"
  if (Test-Path -LiteralPath $preferred) {
    return $preferred
  }

  $fallback = Get-ChildItem -LiteralPath $AssetsPath -Filter "app-*.png" -File |
    Sort-Object Name |
    Select-Object -First 1

  if ($fallback) {
    return $fallback.FullName
  }

  throw "Could not find the ChatGPT Desktop Codex icon under $AssetsPath."
}

if (-not (Test-Path -LiteralPath "package.json")) {
  throw "Run this script from the codex-web repository root."
}

$node = Resolve-RequiredCommand -Names @("node.exe", "node") -ErrorMessage "Could not find Node.js. Install Node.js 22.12+ and re-run npm run build."
$npm = Resolve-RequiredCommand -Names @("npm.cmd", "npm") -ErrorMessage "Could not find npm. Install Node.js and re-run npm run build."
$runtimeManifest = Get-Content -LiteralPath "scripts\runtime-versions.json" -Raw | ConvertFrom-Json
if (($UseNewestInstalledDesktop -and $AppVersion) -or ($AppAsarPath -and ($UseNewestInstalledDesktop -or $AppVersion))) {
  throw "Use only one Desktop source override: -AppAsarPath, -AppVersion, or -UseNewestInstalledDesktop."
}
if (($AppAsarUnpackedPath -or $AppResourcesPath) -and -not $AppAsarPath) {
  throw "-AppAsarUnpackedPath and -AppResourcesPath can only be used with -AppAsarPath."
}
$chatGPTDesktopAsar = Resolve-ChatGPTDesktopAsar `
  -RequestedVersion $AppVersion `
  -ExplicitAsarPath $AppAsarPath `
  -ExplicitUnpackedPath $AppAsarUnpackedPath `
  -ExplicitResourcesPath $AppResourcesPath `
  -UseNewest ([bool]$UseNewestInstalledDesktop) `
  -Manifest $runtimeManifest
$asarPath = "scratch\chatgpt-desktop.asar"
$asarOut = "scratch\asar"

Write-Host "Using Node: $node"
Write-Host "Using npm:  $npm"
Write-Host "Using ChatGPT Desktop app.asar: $($chatGPTDesktopAsar.Path)"
Write-Host "Using ChatGPT Desktop Resources: $($chatGPTDesktopAsar.ResourcesPath)"
Write-Host "Desktop package source: $($chatGPTDesktopAsar.Source)"

if (-not $SkipInstall) {
  Invoke-Step "Check native modules are not in use" {
    Assert-FileNotLocked `
      -Path "node_modules\better-sqlite3\build\Release\better_sqlite3.node" `
      -ErrorMessage "The current codex-web server is still using a native module. Close its console window or stop that project server, then run setup again."
    Assert-FileNotLocked `
      -Path "node_modules\node-pty\build\Release\conpty.node" `
      -ErrorMessage "The current codex-web server is still using a native module. Close its console window or stop that project server, then run setup again."
    Get-ChildItem -Path "node_modules\node-hid\build\Release\HID.node","node_modules\node-hid\prebuilds\*\*.node" -File -ErrorAction SilentlyContinue |
      ForEach-Object {
        Assert-FileNotLocked `
          -Path $_.FullName `
          -ErrorMessage "The current codex-web server is still using a native module. Close its console window or stop that project server, then run setup again."
      }
    Get-ChildItem -Path "node_modules\@serialport\bindings-cpp\build\Release\bindings.node","node_modules\@serialport\bindings-cpp\prebuilds\*\*.node" -File -ErrorAction SilentlyContinue |
      ForEach-Object {
        Assert-FileNotLocked `
          -Path $_.FullName `
          -ErrorMessage "The current codex-web server is still using a native module. Close its console window or stop that project server, then run setup again."
      }
    Get-ChildItem -Path "node_modules\node-pty\prebuilds\win32-*\conpty.node" -File -ErrorAction SilentlyContinue |
      ForEach-Object {
        Assert-FileNotLocked `
          -Path $_.FullName `
          -ErrorMessage "The current codex-web server is still using a native module. Close its console window or stop that project server, then run setup again."
      }
  }

  Invoke-Step "Install npm dependencies" {
    Invoke-NativeCommand -FilePath $npm -Arguments @("ci", "--ignore-scripts") -Name "npm ci"
  }

  Invoke-Step "Rebuild native modules" {
    Invoke-NativeCommand -FilePath $npm -Arguments @("run", "rebuild:native") -Name "npm run rebuild:native"
  }
}

if (-not $SkipPinnedCli) {
  Invoke-Step "Prepare pinned Codex CLI" {
    $runtimeArguments = @(".\scripts\managed-runtime.mjs", "prepare")
    if ($DownloadProxy) {
      $runtimeArguments += @("--proxy", $DownloadProxy)
    }
    Invoke-NativeCommand -FilePath $node -Arguments $runtimeArguments -Name "prepare pinned Codex CLI"
    Write-Host "Pinned Codex version: $($runtimeManifest.codexCli.version)"
  }
}

Invoke-Step "Copy ChatGPT Desktop app.asar" {
  New-Item -ItemType Directory -Force -Path "scratch" | Out-Null
  Copy-Item -LiteralPath $chatGPTDesktopAsar.Path -Destination $asarPath -Force
}

Invoke-Step "Extract required app.asar files" {
  Invoke-NativeCommand -FilePath $node -Arguments @(
    ".\scripts\extract-needed-asar.mjs",
    "--asar", $asarPath,
    "--unpacked-root", $chatGPTDesktopAsar.UnpackedPath,
    "--platform", "win32",
    "--out", $asarOut,
    "--force"
  ) -Name "extract-needed-asar"
}

Invoke-Step "Copy Desktop native and Computer Use resources" {
  Invoke-NativeCommand -FilePath $node -Arguments @(
    ".\scripts\copy-desktop-resources.mjs",
    "--resources", $chatGPTDesktopAsar.ResourcesPath,
    "--platform", "win32",
    "--out", $asarOut
  ) -Name "copy-desktop-resources"
}

$desktopPackageJsonPath = Join-Path $asarOut "package.json"
$desktopPackage = Get-Content -LiteralPath $desktopPackageJsonPath -Raw | ConvertFrom-Json
$desktopAppVersion = [string]$desktopPackage.version
$desktopAppBrand = [string]$desktopPackage.codexAppBrand
$desktopElectronVersion = [string]$desktopPackage.devDependencies.electron
if (-not $desktopAppVersion) {
  throw "The extracted ChatGPT Desktop package does not contain a version."
}
if ($desktopAppBrand -ne "chatgpt") {
  throw "The selected ASAR is not the ChatGPT-branded Codex workspace app (codexAppBrand=$desktopAppBrand). Update the desktop app and retry."
}
if (-not $AppAsarPath -and -not $AppVersion -and -not $UseNewestInstalledDesktop) {
  $expectedAsarVersion = [string]$runtimeManifest.windowsDesktop.asarVersion
  $expectedElectronVersion = [string]$runtimeManifest.windowsDesktop.electronVersion
  if ($desktopAppVersion -ne $expectedAsarVersion -or $desktopElectronVersion -ne $expectedElectronVersion) {
    throw "Pinned Windows Desktop metadata mismatch. Expected ASAR $expectedAsarVersion / Electron $expectedElectronVersion, got ASAR $desktopAppVersion / Electron $desktopElectronVersion."
  }
}

Write-Host "Desktop Appx identity:   $($chatGPTDesktopAsar.Identity)"
Write-Host "Desktop Appx version:    $($chatGPTDesktopAsar.PackageVersion)"
Write-Host "Desktop ASAR version:    $desktopAppVersion"
Write-Host "Desktop ASAR brand:      $desktopAppBrand"
Write-Host "Desktop Electron:        $desktopElectronVersion"

Invoke-Step "Copy browser assets" {
  Copy-Item -Path ".\assets\*" -Destination ".\scratch\asar\webview\" -Force
}

Invoke-Step "Generate PWA icon" {
  $pwaSourceIcon = Resolve-PwaSourceIcon -AssetsPath "scratch\asar\webview\assets"
  Invoke-NativeCommand -FilePath $node -Arguments @(
    ".\scripts\generate-pwa-icon.mjs",
    $pwaSourceIcon,
    "scratch\asar\webview\assets\pwa-icon-512.png"
  ) -Name "generate-pwa-icon"
}

Invoke-Step "Apply ChatGPT Desktop patches" {
  Invoke-NativeCommand -FilePath $node -Arguments @(
    ".\scripts\patch-desktop-asar.mjs",
    "--root",
    $asarOut,
    "--app-version",
    $desktopAppVersion
  ) -Name "patch-desktop-asar"

  foreach ($nativeModule in @("better-sqlite3", "node-pty")) {
    Remove-Item -LiteralPath "scratch\asar\node_modules\$nativeModule" -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Invoke-Step "Audit Desktop runtime externals" {
  Invoke-NativeCommand -FilePath $node -Arguments @(
    ".\scripts\audit-runtime-externals.mjs",
    "--root", $asarOut,
    "--platform", "win32"
  ) -Name "audit-runtime-externals"
}

Invoke-Step "Build browser bundle" {
  Invoke-NativeCommand -FilePath $npm -Arguments @("run", "build:browser") -Name "npm run build:browser"
}

Invoke-Step "Build server bundle" {
  Invoke-NativeCommand -FilePath $npm -Arguments @("run", "build:server") -Name "npm run build:server"
}

Write-Host ""
Write-Host "Windows setup complete."
Write-Host "Local start: npm run server"

if ($setupHasMutex) {
  $setupMutex.ReleaseMutex()
}
$setupMutex.Dispose()
