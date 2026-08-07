param(
  [string]$HostName = "",
  [int]$Port = 8214,
  [string]$CodexPath = "",
  [string]$DownloadProxy = "",
  [string]$TailscalePath = "",
  [string]$TailscaleSocket = "",
  [string]$TailscaleIPv4 = "",
  [string]$TailscaleDNSName = "",
  [switch]$PreferTailscale
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Ensure-CodexWebBuild {
  param(
    [string]$ExplicitCodexPath,
    [string]$Proxy
  )

  $serverEntry = Join-Path $PSScriptRoot "src\server\main.js"
  $webviewEntry = Join-Path $PSScriptRoot "scratch\asar\webview\index.html"
  $hasRuntime = [bool]$ExplicitCodexPath
  if (-not $hasRuntime) {
    & node .\scripts\managed-runtime.mjs resolve *> $null
    $hasRuntime = $LASTEXITCODE -eq 0
  }
  if ((Test-Path -LiteralPath $serverEntry) -and (Test-Path -LiteralPath $webviewEntry) -and $hasRuntime) {
    return
  }

  $setupScript = Join-Path $PSScriptRoot "setup-windows.ps1"
  if (-not (Test-Path -LiteralPath $setupScript)) {
    throw "Build outputs are missing and setup-windows.ps1 was not found."
  }

  Write-Host "codex-web build outputs are missing. Running Windows setup first..."
  $setupArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $setupScript)
  if ($Proxy) {
    $setupArguments += @("-DownloadProxy", $Proxy)
  }
  if ($ExplicitCodexPath) {
    $setupArguments += "-SkipPinnedCli"
  }
  & powershell.exe @setupArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Windows setup failed with exit code $LASTEXITCODE."
  }
  if (-not (Test-Path -LiteralPath $serverEntry) -or -not (Test-Path -LiteralPath $webviewEntry)) {
    throw "Windows setup completed without producing the required codex-web build outputs."
  }
}

function Resolve-TailscaleCommand {
  param([string]$ExplicitPath)

  if ($ExplicitPath) {
    return (Resolve-Path -LiteralPath $ExplicitPath -ErrorAction Stop).ProviderPath
  }

  foreach ($name in @("tailscale.exe", "tailscale")) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }

  return $null
}

function Get-TailscaleInfo {
  param(
    [string]$ExplicitPath,
    [string]$Socket,
    [string]$IPv4Override,
    [string]$DNSNameOverride
  )

  $info = [ordered]@{
    Available = $false
    Command = $null
    Error = $null
    IPv4 = $null
    DNSName = $null
    HostName = $null
  }

  $tailscale = Resolve-TailscaleCommand -ExplicitPath $ExplicitPath
  if (-not $tailscale) {
    $info.Error = "Could not find the Tailscale CLI. Pass -TailscalePath C:\path\to\tailscale.exe."
    return [pscustomobject]$info
  }

  $info.Command = $tailscale
  try {
    $tailscaleArguments = New-Object System.Collections.Generic.List[string]
    if ($Socket) {
      $tailscaleArguments.Add("--socket=$Socket")
    }
    $tailscaleArguments.Add("status")
    $tailscaleArguments.Add("--json")

    # Windows PowerShell otherwise decodes native stdout with the active OEM
    # code page, which can corrupt JSON when a Tailnet device has a Unicode
    # hostname. Tailscale emits UTF-8 on every supported host.
    $previousOutputEncoding = [Console]::OutputEncoding
    try {
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      $statusOutput = & $tailscale @tailscaleArguments 2>&1
    } finally {
      [Console]::OutputEncoding = $previousOutputEncoding
    }
    if ($LASTEXITCODE -ne 0) {
      throw "tailscale status failed with exit code $LASTEXITCODE`: $($statusOutput -join [Environment]::NewLine)"
    }
    $status = ($statusOutput -join [Environment]::NewLine) | ConvertFrom-Json
    $self = $status.Self
    if ($self) {
      $info.Available = [bool]$self.Online
      $info.HostName = $self.HostName
      if ($self.DNSName) {
        $info.DNSName = [string]$self.DNSName
        $info.DNSName = $info.DNSName.TrimEnd(".")
      }
      foreach ($ip in @($self.TailscaleIPs)) {
        if ($ip -match '^\d+\.\d+\.\d+\.\d+$') {
          $info.IPv4 = [string]$ip
          break
        }
      }
    }
    if ($IPv4Override) {
      $parsedAddress = $null
      if (-not [System.Net.IPAddress]::TryParse($IPv4Override, [ref]$parsedAddress) -or $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw "-TailscaleIPv4 must be a valid IPv4 address."
      }
      $info.IPv4 = $IPv4Override
    }
    if ($DNSNameOverride) {
      $info.DNSName = $DNSNameOverride.TrimEnd(".")
    }
  } catch {
    $info.Available = $false
    $info.Error = $_.Exception.Message
  }

  return [pscustomobject]$info
}

function Resolve-CodexCliPath {
  param([string]$ExplicitPath)

  if ($ExplicitPath) {
    $resolvedPath = (Resolve-Path -LiteralPath $ExplicitPath -ErrorAction Stop).ProviderPath
    $versionOutput = & $resolvedPath --version 2>$null | Select-Object -First 1
    $versionText = ([string]$versionOutput).Trim()
    if ($versionText -notmatch 'codex-cli\s+[^\s]+') {
      throw "Explicit Codex CLI is not runnable: $resolvedPath"
    }
    Write-Host "Using explicit Codex CLI version: $versionText"
    return $resolvedPath
  }

  $pinnedPath = (& node .\scripts\managed-runtime.mjs resolve 2>$null | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0 -or -not $pinnedPath) {
    throw "The repository-pinned Codex CLI is missing or invalid. Re-run setup-windows.ps1."
  }
  Write-Host "Using repository-pinned Codex CLI."
  return ([string]$pinnedPath).Trim()
}

function Show-CodexWebLinks {
  param(
    [string]$ListenHost,
    [int]$ListenPort,
    [object]$TailscaleInfo
  )

  Write-Host ""
  Write-Host "codex-web links"
  Write-Host "---------------"

  if ($ListenHost -eq "127.0.0.1" -or $ListenHost -eq "localhost" -or $ListenHost -eq "0.0.0.0") {
    Write-Host ("Local:     http://127.0.0.1:{0}/" -f $ListenPort)
  }

  if ($TailscaleInfo.Available -and $TailscaleInfo.IPv4) {
    if ($ListenHost -eq $TailscaleInfo.IPv4 -or $ListenHost -eq "0.0.0.0") {
      Write-Host ("Tailnet:   http://{0}:{1}/" -f $TailscaleInfo.IPv4, $ListenPort)
      if ($TailscaleInfo.DNSName) {
        Write-Host ("MagicDNS:  http://{0}:{1}/" -f $TailscaleInfo.DNSName, $ListenPort)
      }
    } else {
      Write-Host ("Tailnet:   Tailscale is online as {0}, but this server is listening on {1}." -f $TailscaleInfo.IPv4, $ListenHost)
      Write-Host "           Restart with -PreferTailscale to expose it inside your tailnet."
    }
  } else {
    Write-Host "Tailnet:   Tailscale address was not detected."
  }

  Write-Host ""
  Write-Host "If this window started the server, keep it open while using codex-web."
  Write-Host "Only use the Tailnet link from devices you trust."
  Write-Host ""
}

function Get-PortListener {
  param([int]$ListenPort)

  return Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

Ensure-CodexWebBuild -ExplicitCodexPath $CodexPath -Proxy $DownloadProxy

$tailscaleInfo = Get-TailscaleInfo `
  -ExplicitPath $TailscalePath `
  -Socket $TailscaleSocket `
  -IPv4Override $TailscaleIPv4 `
  -DNSNameOverride $TailscaleDNSName
if (-not $HostName) {
  if ($PreferTailscale) {
    if (-not $tailscaleInfo.Available -or -not $tailscaleInfo.IPv4) {
      $reason = if ($tailscaleInfo.Error) { $tailscaleInfo.Error } else { "Tailscale is offline or has no IPv4 address." }
      throw "-PreferTailscale was requested, but a usable Tailnet address was not found. $reason"
    }
    $HostName = $tailscaleInfo.IPv4
  } else {
    $HostName = "127.0.0.1"
  }
}

$existingListeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($existingListeners.Count -gt 0) {
  $listener = $existingListeners | Select-Object -First 1
  throw "Port $Port is already in use by PID $($listener.OwningProcess). Stop that process or choose another -Port."
}

$CodexPath = Resolve-CodexCliPath -ExplicitPath $CodexPath
$env:CODEX_CLI_PATH = $CodexPath

Write-Host "Using Codex CLI: $env:CODEX_CLI_PATH"
Write-Host ("Listening on {0}:{1}" -f $HostName, $Port)
Show-CodexWebLinks -ListenHost $HostName -ListenPort $Port -TailscaleInfo $tailscaleInfo

node .\scripts\run-server.mjs --host $HostName --port $Port
