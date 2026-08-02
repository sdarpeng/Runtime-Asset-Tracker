[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Project,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Environment,
  [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Owner = 'platform-engineering',
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'RuntimeAssetTracker'),
  [string]$LedgerFile = (Join-Path $env:LOCALAPPDATA 'RuntimeAssetTracker\events.jsonl')
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$source = Join-Path $PSScriptRoot 'runtime-asset-ledger.mjs'
$target = Join-Path $InstallDirectory 'runtime-asset-ledger.mjs'
$launcher = Join-Path $InstallDirectory 'Start-RuntimeAssetTracker.ps1'

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force

$launcherContent = @"
`$env:RUNTIME_ASSET_PROJECT = '$Project'
`$env:RUNTIME_ASSET_ENVIRONMENT = '$Environment'
`$env:RUNTIME_ASSET_OWNER = '$Owner'
`$env:RUNTIME_ASSET_LEDGER_FILE = '$LedgerFile'
& '$node' '$target' watch
"@
Set-Content -LiteralPath $launcher -Value $launcherContent -Encoding utf8

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runCommand = "powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name 'RuntimeAssetTracker' -Value $runCommand -PropertyType String -Force | Out-Null

Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher)
Start-Sleep -Seconds 2

if (-not (Test-Path -LiteralPath $LedgerFile)) {
  throw "Tracker did not create its ledger: $LedgerFile"
}

Write-Host "Runtime Asset Tracker installed for $Project/$Environment. Docker Desktop and containers were not restarted."
Write-Host "Ledger: $LedgerFile"
