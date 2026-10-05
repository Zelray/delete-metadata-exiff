<#
.SYNOPSIS
  MetaDesk dev launcher: pick a free port, verify the engine, start the server
  workspace when it exists, health-check, open the browser.

.DESCRIPTION
  This is the working dev entry point for leaf 1.1.1. It deliberately does
  three things and nothing else:

    1. Picks a free loopback port and writes app/data/portfile.json.
    2. Runs the engine smoke probe (bin/engine-smoke.mjs) against the vendored
       app/vendor/exiftool/exiftool.exe: -ver handshake, -stay_open framing,
       a write with default backup mode, a read-back, and a clean shutdown
       with no orphan process.
    3. If server/src/index.ts exists (a later leaf), starts the server
       workspace on the chosen port, polls /api/health, and opens the browser.
       Until then it reports the engine status and exits 0 without opening a
       dead tab.

  A later leaf (buildOutline step 7) replaces this with the real launcher
  (single-instance mutex, idle exit, Tauri-tied lifecycle). Nothing here
  touches user photos: the smoke probe works only on a throwaway temp file.
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [switch]$NoBrowser,
  [switch]$SkipEngineSmoke
)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
$Exe = Join-Path $AppRoot 'vendor\exiftool\exiftool.exe'
$DataDir = Join-Path $AppRoot 'data'
$PortFilePath = Join-Path $DataDir 'portfile.json'
$ServerEntry = Join-Path $AppRoot 'server\src\index.ts'
$Child = $null

function Write-Step([string]$Status, [string]$Message) {
  $stamp = (Get-Date).ToString('HH:mm:ss')
  Write-Host "[$stamp] $Status  $Message"
}

function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return [int]$listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Get-ExiftoolProcessCount {
  return @(Get-Process -Name 'exiftool' -ErrorAction SilentlyContinue).Count
}

try {
  if (-not (Test-Path $Exe)) {
    throw "Vendored engine missing: $Exe (copy, never move, from repo-root vendor/exiftool/)"
  }

  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  if ($Port -le 0) { $Port = Get-FreePort }
  $exiftoolBefore = Get-ExiftoolProcessCount

  Write-Step 'engine ' "verifying $Exe"
  if (-not $SkipEngineSmoke) {
    $smoke = & node (Join-Path $PSScriptRoot 'engine-smoke.mjs') 2>&1
    $smoke | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) {
      throw "Engine smoke probe failed (exit $LASTEXITCODE). The app must stay read-only; fix the engine before launching."
    }
  } else {
    Write-Step 'engine ' 'smoke probe skipped by request'
  }

  # Portfile: how later tooling finds the running instance.
  # NOTE: PowerShell variable names are case-insensitive, so this must not be
  # called $PortFile (it would overwrite $PortFilePath above).
  $portfilePayload = [ordered]@{
    port      = $Port
    pid       = $PID
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    engine    = $Exe
    url       = "http://127.0.0.1:$Port/"
  }
  $portfilePayload | ConvertTo-Json | Set-Content -Path $PortFilePath -Encoding utf8
  Write-Step 'port   ' "$Port (portfile: $PortFilePath)"

  if (Test-Path $ServerEntry) {
    Write-Step 'server ' 'starting server workspace'
    $tsxEntry = Join-Path $AppRoot 'node_modules\tsx\dist\cli.mjs'
    if (Test-Path $tsxEntry) {
      $Child = Start-Process -FilePath 'node' -ArgumentList @($tsxEntry, $ServerEntry, '--port', "$Port") `
        -WorkingDirectory $AppRoot -PassThru -NoNewWindow
    } else {
      $Child = Start-Process -FilePath 'npx.cmd' -ArgumentList @('--no-install', 'tsx', $ServerEntry, '--port', "$Port") `
        -WorkingDirectory $AppRoot -PassThru -NoNewWindow
    }

    $healthUrl = "http://127.0.0.1:$Port/api/health"
    Write-Step 'health ' "polling $healthUrl"
    $deadline = (Get-Date).AddSeconds(30)
    $healthy = $false
    while ((Get-Date) -lt $deadline -and -not $healthy) {
      if ($Child.HasExited) { throw "Server process exited during startup (code $($Child.ExitCode))." }
      try {
        $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
        $healthy = ($response.StatusCode -eq 200)
      } catch {
        Start-Sleep -Milliseconds 400
      }
    }
    if (-not $healthy) { throw "Server did not become healthy within 30s at $healthUrl." }
    Write-Step 'health ' 'ok'

    if (-not $NoBrowser) {
      Write-Step 'ui     ' "opening http://127.0.0.1:$Port/"
      Start-Process "http://127.0.0.1:$Port/"
    }
    Write-Step 'ready  ' 'MetaDesk dev server is running. Ctrl+C to stop.'
    Wait-Process -Id $Child.Id -ErrorAction SilentlyContinue
  } else {
    Write-Step 'server ' 'server/src/index.ts not built yet (later leaf) - engine layer verified only.'
    Write-Step 'result ' 'engine layer healthy; launcher infrastructure working.'
  }
  exit 0
} catch {
  Write-Step 'FAILED' $_.Exception.Message
  exit 1
} finally {
  if ($null -ne $Child -and -not $Child.HasExited) {
    Write-Step 'cleanup' "stopping server process $($Child.Id)"
    try {
      $Child.CloseMainWindow() | Out-Null
      if (-not $Child.WaitForExit(5000)) { Stop-Process -Id $Child.Id -Force }
    } catch {
      try { Stop-Process -Id $Child.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
  }
  $exiftoolAfter = Get-ExiftoolProcessCount
  if ($exiftoolAfter -gt $exiftoolBefore) {
    Write-Step 'WARN   ' "$($exiftoolAfter - $exiftoolBefore) exiftool process(es) still running after exit"
  } else {
    Write-Step 'cleanup' "no orphan exiftool processes ($exiftoolAfter running)"
  }
}
