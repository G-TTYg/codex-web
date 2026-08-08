<#
Responsibility: Acquire and validate the pinned Windows Desktop MSIX when its
exact Store package is not installed, then expose its extracted Resources tree.
Boundary: Download integrity is manifest-owned; Windows signature and Appx
identity validation happen here. No newer-version discovery is permitted.
#>

function Get-WindowsDesktopArchitecture {
  param([string]$Node)

  $architectureOutput = & $Node -p "process.arch"
  if ($LASTEXITCODE -ne 0) {
    throw "Reading the active Node.js architecture failed with exit code $LASTEXITCODE."
  }
  $architecture = ([string]$architectureOutput).Trim().ToLowerInvariant()
  if ($architecture -notin @("x64", "arm64")) {
    throw "Unsupported Windows Desktop architecture: $architecture."
  }
  return $architecture
}

function Assert-ManagedScratchPath {
  param(
    [string]$Path,
    [string]$ProjectRoot
  )

  $scratchRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "scratch"))
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $scratchPrefix = $scratchRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.StartsWith($scratchPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a managed Desktop path outside project scratch: $fullPath"
  }
  return $fullPath
}

function Get-SriHexDigest {
  param(
    [string]$Integrity,
    [string]$ExpectedAlgorithm
  )

  $parts = $Integrity.Split("-", 2)
  if ($parts.Count -ne 2 -or $parts[0].ToLowerInvariant() -ne $ExpectedAlgorithm.ToLowerInvariant()) {
    throw "Expected a $ExpectedAlgorithm SRI value, got: $Integrity"
  }
  try {
    return -join ([System.Convert]::FromBase64String($parts[1]) | ForEach-Object { $_.ToString("x2") })
  } catch {
    throw "Invalid SRI base64 value: $Integrity"
  }
}

function Read-AppxIdentityFromArchive {
  param([string]$ArchivePath)

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $requiredEntries = @("AppxManifest.xml", "AppxBlockMap.xml", "AppxSignature.p7x")
    foreach ($requiredEntry in $requiredEntries) {
      if (-not ($archive.Entries | Where-Object { $_.FullName -eq $requiredEntry } | Select-Object -First 1)) {
        throw "Managed Desktop package is missing $requiredEntry."
      }
    }
    $manifestEntry = $archive.Entries | Where-Object { $_.FullName -eq "AppxManifest.xml" } | Select-Object -First 1
    $stream = $manifestEntry.Open()
    $reader = [System.IO.StreamReader]::new($stream)
    try {
      [xml]$manifestXml = $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
      $stream.Dispose()
    }
    $identity = $manifestXml.Package.Identity
    return @{
      Name = [string]$identity.Name
      Publisher = [string]$identity.Publisher
      Version = [string]$identity.Version
      Architecture = [string]$identity.ProcessorArchitecture
    }
  } finally {
    $archive.Dispose()
  }
}

function Assert-AppxIdentity {
  param(
    [hashtable]$Identity,
    [object]$Descriptor
  )

  $expected = @{
    Name = [string]$Descriptor.packageIdentity
    Publisher = [string]$Descriptor.packagePublisher
    Version = [string]$Descriptor.packageVersion
    Architecture = [string]$Descriptor.arch
  }
  foreach ($field in $expected.Keys) {
    if ([string]$Identity[$field] -cne [string]$expected[$field]) {
      throw "Pinned Windows Desktop $field mismatch. Expected '$($expected[$field])', got '$($Identity[$field])'."
    }
  }
}

function Read-AppxIdentityFromDirectory {
  param([string]$PackageRoot)

  $manifestPath = Join-Path $PackageRoot "AppxManifest.xml"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Extracted managed Desktop package is missing AppxManifest.xml."
  }
  [xml]$manifestXml = Get-Content -LiteralPath $manifestPath -Raw
  $identity = $manifestXml.Package.Identity
  return @{
    Name = [string]$identity.Name
    Publisher = [string]$identity.Publisher
    Version = [string]$identity.Version
    Architecture = [string]$identity.ProcessorArchitecture
  }
}

function Assert-ManagedDesktopArchive {
  param(
    [string]$ArchivePath,
    [object]$Descriptor
  )

  $archiveItem = Get-Item -LiteralPath $ArchivePath -ErrorAction Stop
  if ($archiveItem.Length -ne [long]$Descriptor.artifact.size) {
    throw "Pinned Windows Desktop size mismatch. Expected $($Descriptor.artifact.size), got $($archiveItem.Length)."
  }
  $expectedSha256 = Get-SriHexDigest -Integrity ([string]$Descriptor.artifact.integrity) -ExpectedAlgorithm "sha256"
  $actualSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -cne $expectedSha256) {
    throw "Pinned Windows Desktop SHA-256 mismatch. Expected $expectedSha256, got $actualSha256."
  }

  # Authenticode validates the Appx block map and its chain. The signer must be
  # the same Store publisher declared by the pinned Appx identity, issued by a
  # Microsoft marketplace CA rather than by the transport mirror.
  $signature = Get-AuthenticodeSignature -LiteralPath $ArchivePath
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Pinned Windows Desktop signature is not valid: $($signature.Status) ($($signature.StatusMessage))"
  }
  if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -cne [string]$Descriptor.packagePublisher) {
    throw "Pinned Windows Desktop signer mismatch. Expected '$($Descriptor.packagePublisher)', got '$($signature.SignerCertificate.Subject)'."
  }
  if ($signature.SignerCertificate.Issuer -notmatch "(?:^|,\s*)O=Microsoft Corporation(?:,|$)") {
    throw "Pinned Windows Desktop signer was not issued by Microsoft Marketplace: '$($signature.SignerCertificate.Issuer)'."
  }

  $identity = Read-AppxIdentityFromArchive -ArchivePath $ArchivePath
  Assert-AppxIdentity -Identity $identity -Descriptor $Descriptor
  return $identity
}

function Expand-ManagedDesktopArchive {
  param(
    [string]$ArchivePath,
    [string]$Destination,
    [string]$ProjectRoot
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $safeDestination = Assert-ManagedScratchPath -Path $Destination -ProjectRoot $ProjectRoot
  $staging = Assert-ManagedScratchPath -Path "$safeDestination.staging-$PID-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -ProjectRoot $ProjectRoot
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null

  try {
    $stagingPrefix = $staging.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
      foreach ($entry in $archive.Entries) {
        # Appx block-map names are URI paths. Store deployment decodes escaped
        # scoped-package directories such as %40oai to @oai; raw Zip extraction
        # would silently create an unusable Node module tree.
        $decodedEntryName = [System.Uri]::UnescapeDataString($entry.FullName)
        $entryPath = [System.IO.Path]::GetFullPath((Join-Path $staging $decodedEntryName))
        if (-not $entryPath.StartsWith($stagingPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
          throw "Managed Desktop package contains an unsafe archive path: $($entry.FullName)"
        }
        if (-not $entry.Name) {
          New-Item -ItemType Directory -Force -Path $entryPath | Out-Null
          continue
        }
        $entryParent = Split-Path -Parent $entryPath
        New-Item -ItemType Directory -Force -Path $entryParent | Out-Null
        $inputStream = $entry.Open()
        $outputStream = [System.IO.File]::Open($entryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
          $inputStream.CopyTo($outputStream)
        } finally {
          $outputStream.Dispose()
          $inputStream.Dispose()
        }
      }
    } finally {
      $archive.Dispose()
    }

    if (Test-Path -LiteralPath $safeDestination) {
      Remove-Item -LiteralPath $safeDestination -Recurse -Force
    }
    Move-Item -LiteralPath $staging -Destination $safeDestination
  } finally {
    if (Test-Path -LiteralPath $staging) {
      Remove-Item -LiteralPath $staging -Recurse -Force
    }
  }
  return $safeDestination
}

function Find-DesktopAsarInPackageRoot {
  param([string]$PackageRoot)

  foreach ($relativePath in @("app\resources\app.asar", "resources\app.asar")) {
    $candidate = Join-Path $PackageRoot $relativePath
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  throw "The validated pinned Windows Desktop package contains no app.asar."
}

function Resolve-ManagedDesktopPackage {
  param(
    [string]$Node,
    [string]$Architecture,
    [string]$DownloadProxy,
    [object]$Manifest,
    [string]$ProjectRoot
  )

  $managerPath = Join-Path $ProjectRoot "scripts\windows\managed-desktop.mjs"
  $descriptionJson = & $Node $managerPath "describe" "--arch" $Architecture
  if ($LASTEXITCODE -ne 0) {
    throw "Describing the pinned Windows Desktop package failed with exit code $LASTEXITCODE."
  }
  $descriptor = $descriptionJson | ConvertFrom-Json
  if (
    [string]$descriptor.packageIdentity -cne [string]$Manifest.windowsDesktop.packageIdentity -or
    [string]$descriptor.packagePublisher -cne [string]$Manifest.windowsDesktop.packagePublisher -or
    [string]$descriptor.packageVersion -cne [string]$Manifest.windowsDesktop.packageVersion
  ) {
    throw "Managed Windows Desktop descriptor does not match runtime-versions.json."
  }

  $prepareArguments = @($managerPath, "prepare", "--arch", $Architecture)
  if ($DownloadProxy) {
    $prepareArguments += @("--proxy", $DownloadProxy)
  }
  & $Node @prepareArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Preparing the pinned Windows Desktop package failed with exit code $LASTEXITCODE."
  }

  $identity = Assert-ManagedDesktopArchive -ArchivePath ([string]$descriptor.archivePath) -Descriptor $descriptor
  $digest = Get-SriHexDigest -Integrity ([string]$descriptor.artifact.integrity) -ExpectedAlgorithm "sha256"
  $packageRoot = Join-Path $ProjectRoot "scratch\desktop-packages\$($descriptor.packageVersion)-$Architecture-$($digest.Substring(0, 12))"
  $markerPath = Join-Path $packageRoot ".codex-web-source.json"
  $canReuseExtraction = $false
  if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
    try {
      $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
      if (
        [int]$marker.extractionFormat -eq 1 -and
        [string]$marker.integrity -ceq [string]$descriptor.artifact.integrity -and
        [long]$marker.size -eq [long]$descriptor.artifact.size -and
        [string]$marker.url -ceq [string]$descriptor.artifact.url
      ) {
        $cachedIdentity = Read-AppxIdentityFromDirectory -PackageRoot $packageRoot
        Assert-AppxIdentity -Identity $cachedIdentity -Descriptor $descriptor
        $null = Find-DesktopAsarInPackageRoot -PackageRoot $packageRoot
        $canReuseExtraction = $true
      }
    } catch {
      Write-Host "Ignoring invalid managed Desktop extraction cache: $($_.Exception.Message)"
    }
  }
  if ($canReuseExtraction) {
    Write-Host "Using verified managed Desktop extraction: $packageRoot"
  } else {
    $packageRoot = Expand-ManagedDesktopArchive -ArchivePath ([string]$descriptor.archivePath) -Destination $packageRoot -ProjectRoot $ProjectRoot
    @{
      extractionFormat = 1
      integrity = [string]$descriptor.artifact.integrity
      size = [long]$descriptor.artifact.size
      url = [string]$descriptor.artifact.url
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot ".codex-web-source.json") -Encoding UTF8
  }
  $extractedIdentity = Read-AppxIdentityFromDirectory -PackageRoot $packageRoot
  Assert-AppxIdentity -Identity $extractedIdentity -Descriptor $descriptor
  $asarPath = Find-DesktopAsarInPackageRoot -PackageRoot $packageRoot
  $resourcesPath = Split-Path -Parent $asarPath

  return @{
    Identity = [string]$identity.Name
    PackageVersion = [string]$identity.Version
    Path = $asarPath
    ResourcesPath = $resourcesPath
    UnpackedPath = Join-Path $resourcesPath "app.asar.unpacked"
    Source = "managed:$($descriptor.artifact.url)"
  }
}
