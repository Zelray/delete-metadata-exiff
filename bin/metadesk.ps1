<#
.SYNOPSIS
  MetaDesk production launcher: starts (or stops) MetaDesk with the shared
  v1 lifecycle in bin/metadesk.mjs.

.DESCRIPTION
  Double-click bin/metadesk.cmd (or run this script) to start MetaDesk:
  free-port pick, server start, /api/health handshake, default browser opens
  at the app URL. Unlike the -dev pair, no engine smoke probe runs - the
  server performs its own -ver handshake at boot and starts READ-ONLY if the
  engine fails, which the UI surfaces as the Read-Only Mode banner.

  Closing the console window (or Ctrl+C) stops MetaDesk gracefully: the
  launcher closes the server's stdin pipe, the established Windows stop
  channel, and the server shuts its engine session down through its graceful
  ladder. `metadesk.ps1 -Stop` stops a running instance from any console.
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [switch]$NoBrowser,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$lifecycleArgs = @((Join-Path $PSScriptRoot 'metadesk.mjs'))
if ($Port -gt 0) { $lifecycleArgs += @('--port', "$Port") }
if ($NoBrowser) { $lifecycleArgs += '--no-browser' }
if ($Stop) { $lifecycleArgs += '--stop' }
& node @lifecycleArgs
exit $LASTEXITCODE
