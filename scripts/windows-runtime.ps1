# Shared Windows acquisition helpers for the repository-pinned Codex CLI.
# Downloads and extracted binaries stay under ignored scratch/ paths; every
# official archive is verified before use.

$script:CodexWebProjectRoot = Split-Path -Parent $PSScriptRoot
$script:CodexWebManagedRoot = Join-Path $script:CodexWebProjectRoot "scratch"
$script:CodexWebRuntimeManifestPath = Join-Path $PSScriptRoot "runtime-versions.json"

function Get-CodexWebRuntimeManifest {
  if (-not (Test-Path -LiteralPath $script:CodexWebRuntimeManifestPath)) {
    throw "Runtime manifest was not found: $script:CodexWebRuntimeManifestPath"
  }

  return Get-Content -LiteralPath $script:CodexWebRuntimeManifestPath -Raw | ConvertFrom-Json
}

function Assert-CodexWebManagedPath {
  param([string]$Path)

  $managedRoot = [System.IO.Path]::GetFullPath($script:CodexWebManagedRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  $prefix = $managedRoot + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolvedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside the project scratch directory: $resolvedPath"
  }
}

function Get-CodexWebIntegrityParts {
  param([string]$Integrity)

  $separator = $Integrity.IndexOf("-")
  if ($separator -le 0 -or $separator -eq ($Integrity.Length - 1)) {
    throw "Invalid SRI integrity value: $Integrity"
  }

  $algorithm = $Integrity.Substring(0, $separator).ToUpperInvariant()
  if ($algorithm -notin @("SHA256", "SHA512")) {
    throw "Unsupported integrity algorithm: $algorithm"
  }

  $hashBytes = [Convert]::FromBase64String($Integrity.Substring($separator + 1))
  return [pscustomobject]@{
    Algorithm = $algorithm
    Hex = (-join ($hashBytes | ForEach-Object { $_.ToString("x2") }))
  }
}

function Test-CodexWebFileIntegrity {
  param(
    [string]$Path,
    [string]$Integrity
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }

  $expected = Get-CodexWebIntegrityParts -Integrity $Integrity
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm $expected.Algorithm).Hash
  return $actual.Equals($expected.Hex, [System.StringComparison]::OrdinalIgnoreCase)
}

function Invoke-CodexWebCurlDownload {
  param(
    [string]$CurlPath,
    [string]$Url,
    [string]$Destination,
    [string]$Proxy,
    [switch]$Resume
  )

  $arguments = New-Object System.Collections.Generic.List[string]
  if ($Proxy) {
    $arguments.Add("--proxy")
    $arguments.Add($Proxy)
  }
  $arguments.Add("--fail")
  $arguments.Add("--location")
  $arguments.Add("--retry")
  $arguments.Add("3")
  $arguments.Add("--progress-bar")
  if ($Resume) {
    $arguments.Add("--continue-at")
    $arguments.Add("-")
  }
  $arguments.Add("--output")
  $arguments.Add($Destination)
  $arguments.Add($Url)

  & $CurlPath @arguments
  return $LASTEXITCODE
}

function Invoke-CodexWebPinnedDownload {
  param(
    [string]$Url,
    [string]$Integrity,
    [string]$Destination,
    [string]$Proxy = ""
  )

  Assert-CodexWebManagedPath -Path $Destination
  if (Test-CodexWebFileIntegrity -Path $Destination -Integrity $Integrity) {
    Write-Host "Using verified cached download: $Destination"
    return $Destination
  }

  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Force
  }

  $destinationDirectory = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
  $partialPath = "$Destination.partial"
  Assert-CodexWebManagedPath -Path $partialPath

  $curl = Get-Command @("curl.exe", "curl") -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $curl) {
    throw "Could not find curl. Windows 10/11 includes curl.exe; install it and retry."
  }

  $resume = (Test-Path -LiteralPath $partialPath) -and ((Get-Item -LiteralPath $partialPath).Length -gt 0)
  $exitCode = Invoke-CodexWebCurlDownload `
    -CurlPath $curl.Source `
    -Url $Url `
    -Destination $partialPath `
    -Proxy $Proxy `
    -Resume:$resume

  if ($exitCode -ne 0 -and $resume) {
    Write-Host "Resume was rejected; restarting the pinned download."
    Remove-Item -LiteralPath $partialPath -Force
    $exitCode = Invoke-CodexWebCurlDownload `
      -CurlPath $curl.Source `
      -Url $Url `
      -Destination $partialPath `
      -Proxy $Proxy
  }
  if ($exitCode -ne 0) {
    throw "Download failed with curl exit code $exitCode`: $Url"
  }
  if (-not (Test-CodexWebFileIntegrity -Path $partialPath -Integrity $Integrity) -and $resume) {
    Write-Host "Resumed download failed integrity; retrying from the beginning."
    Remove-Item -LiteralPath $partialPath -Force
    $exitCode = Invoke-CodexWebCurlDownload `
      -CurlPath $curl.Source `
      -Url $Url `
      -Destination $partialPath `
      -Proxy $Proxy
    if ($exitCode -ne 0) {
      throw "Download failed with curl exit code $exitCode`: $Url"
    }
  }
  if (-not (Test-CodexWebFileIntegrity -Path $partialPath -Integrity $Integrity)) {
    Remove-Item -LiteralPath $partialPath -Force
    throw "Downloaded artifact failed its pinned integrity check: $Url"
  }

  Move-Item -LiteralPath $partialPath -Destination $Destination -Force
  return $Destination
}

function Get-CodexWebWindowsCliDescriptor {
  param([object]$Manifest)

  $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ($architecture -eq "x64") {
    $descriptor = $Manifest.codexCli.windows.x64
  } elseif ($architecture -eq "arm64") {
    $descriptor = $Manifest.codexCli.windows.arm64
  } else {
    throw "The pinned Codex CLI does not support Windows architecture: $architecture"
  }

  return [pscustomobject]@{
    Architecture = $architecture
    Version = [string]$Manifest.codexCli.version
    Url = [string]$descriptor.url
    Integrity = [string]$descriptor.integrity
    Triple = [string]$descriptor.triple
  }
}

function Get-CodexWebPinnedCliPath {
  param([object]$Manifest)

  $descriptor = Get-CodexWebWindowsCliDescriptor -Manifest $Manifest
  return Join-Path $script:CodexWebManagedRoot ("runtime\codex\{0}\{1}\package\vendor\{2}\bin\codex.exe" -f $descriptor.Version, $descriptor.Architecture, $descriptor.Triple)
}

function Assert-CodexWebPinnedCliVersion {
  param(
    [string]$CodexPath,
    [string]$ExpectedVersion
  )

  if (-not (Test-Path -LiteralPath $CodexPath -PathType Leaf)) {
    throw "Pinned Codex CLI is missing: $CodexPath"
  }

  $versionOutput = (& $CodexPath --version 2>$null | Select-Object -First 1)
  $exitCode = $LASTEXITCODE
  $versionText = ([string]$versionOutput).Trim()
  $versionMatch = [regex]::Match($versionText, 'codex-cli\s+([^\s]+)')
  # The Windows CLI can report -1 when its parent redirects all standard
  # handles even though --version produced the exact expected value. Treat the
  # version token as authoritative; missing or different output still fails.
  if (-not $versionMatch.Success -or $versionMatch.Groups[1].Value -ne $ExpectedVersion) {
    throw "Pinned Codex CLI version mismatch (exit $exitCode). Expected codex-cli $ExpectedVersion, got: $versionText"
  }
}

function Initialize-CodexWebPinnedCli {
  param(
    [object]$Manifest,
    [string]$Proxy = ""
  )

  $descriptor = Get-CodexWebWindowsCliDescriptor -Manifest $Manifest
  $archiveName = "codex-$($descriptor.Version)-win32-$($descriptor.Architecture).tgz"
  $archivePath = Join-Path $script:CodexWebManagedRoot "downloads\$archiveName"
  Invoke-CodexWebPinnedDownload `
    -Url $descriptor.Url `
    -Integrity $descriptor.Integrity `
    -Destination $archivePath `
    -Proxy $Proxy | Out-Null

  $codexPath = Get-CodexWebPinnedCliPath -Manifest $Manifest
  try {
    Assert-CodexWebPinnedCliVersion -CodexPath $codexPath -ExpectedVersion $descriptor.Version
    return $codexPath
  } catch {
    # A missing or incomplete extracted tree is replaced only inside scratch/.
  }

  $runtimeRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $codexPath))))
  Assert-CodexWebManagedPath -Path $runtimeRoot
  if (Test-Path -LiteralPath $runtimeRoot) {
    Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
  }

  $runtimeParent = Split-Path -Parent $runtimeRoot
  New-Item -ItemType Directory -Force -Path $runtimeParent | Out-Null
  $stagingRoot = "$runtimeRoot.staging-$PID-$([Guid]::NewGuid().ToString('N'))"
  Assert-CodexWebManagedPath -Path $stagingRoot
  New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null

  try {
    $tar = Get-Command @("tar.exe", "tar") -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $tar) {
      throw "Could not find tar. Windows 10/11 includes tar.exe; install it and retry."
    }
    & $tar.Source -xzf $archivePath -C $stagingRoot
    if ($LASTEXITCODE -ne 0) {
      throw "Extracting the pinned Codex CLI failed with exit code $LASTEXITCODE."
    }

    $stagedCodexPath = Join-Path $stagingRoot ("package\vendor\{0}\bin\codex.exe" -f $descriptor.Triple)
    Assert-CodexWebPinnedCliVersion -CodexPath $stagedCodexPath -ExpectedVersion $descriptor.Version
    Move-Item -LiteralPath $stagingRoot -Destination $runtimeRoot
  } finally {
    if (Test-Path -LiteralPath $stagingRoot) {
      Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
  }

  Assert-CodexWebPinnedCliVersion -CodexPath $codexPath -ExpectedVersion $descriptor.Version
  return $codexPath
}
