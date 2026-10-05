<#
.SYNOPSIS
  MetaDesk DEV launcher: engine smoke probe first, then the real v1 lifecycle
  in bin/metadesk.mjs.

.DESCRIPTION
  The dev wrapper keeps one thing of its own - the engine smoke probe
  (bin/engine-smoke.mjs), which proves BEFORE any UI opens that the vendored
  app/vendor/exiftool/exiftool.exe answers -ver, speaks the -stay_open
  protocol, writes a tag to a throwaway temp file in default backup mode,
  reads it back, and shuts down with no orphan process. That probe writes to
  user photos never; it exists so a broken engine is caught at launch time.

  Everything else - single-instance lock, free-port pick, server start,
  /api/health handshake, browser open, graceful stdin-close stop, --stop
  channel, orphan verification, portfile cleanup - lives in metadesk.mjs so
  the dev pair and the production pair share ONE lifecycle implementation.

  Production entry point: bin/metadesk.ps1 (no smoke probe; the server's own
  boot handshake covers engine health and the app starts read-only if it
  fails, per the ux-spec first-run flow).
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [switch]$NoBrowser,
  [switch]$SkipEngineSmoke,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
$Exe = Join-Path $AppRoot 'vendor\exiftool\exiftool.exe'

# A stop request needs no engine probe - there is nothing to verify.
if (-not $Stop -and -not $SkipEngineSmoke) {
  if (-not (Test-Path $Exe)) {
    Write-Host "[launcher] FAILED  Vendored engine missing: $Exe (copy, never move, from repo-root vendor/exiftool/)"
    exit 1
  }
  Write-Host "[launcher] engine  running smoke probe against $Exe"
  & node (Join-Path $PSScriptRoot 'engine-smoke.mjs')
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[launcher] FAILED  Engine smoke probe failed (exit $LASTEXITCODE). The app must stay read-only; fix the engine before launching."
    exit 1
  }
}

# Delegate the whole lifecycle to the shared Node launcher (argv array).
$lifecycleArgs = @((Join-Path $PSScriptRoot 'metadesk.mjs'))
if ($Port -gt 0) { $lifecycleArgs += @('--port', "$Port") }
if ($NoBrowser) { $lifecycleArgs += '--no-browser' }
if ($Stop) { $lifecycleArgs += '--stop' }
& node @lifecycleArgs
exit $LASTEXITCODE
