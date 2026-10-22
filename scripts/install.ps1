#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$ExtensionId = 'jjjkmmcdkpcgamlopogicbnnhdgebhie',
  [ValidateSet('chrome', 'edge', 'brave', 'chromium', 'arc')]
  [string]$Browser = 'chrome',
  [string]$InstallDir = (Join-Path $HOME '.local\bin'),
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Help) {
  Write-Host 'Install Browser Bridge from GitHub Releases. Options: -Version, -ExtensionId, -Browser, -InstallDir.'
  return
}
if ($ExtensionId -cnotmatch '^[a-z]{32}$') { throw 'Invalid extension ID' }
$nativeArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($nativeArch -ne 'AMD64') { throw 'Unsupported architecture: Windows x64 is required' }
$base = 'https://github.com/koltyakov/browser-bridge/releases/latest/download'
if ($Version) {
  $Version = $Version -replace '^v', ''
  if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([.-][a-zA-Z0-9.-]+)?$') { throw 'Invalid version' }
  $base = "https://github.com/koltyakov/browser-bridge/releases/download/v$Version"
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$asset = 'bbx-windows-x64.exe'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp | Out-Null
$previousAutoUpdate = $env:BBX_AUTO_UPDATE
try {
  $checksumsFile = Join-Path $tmp 'checksums.txt'
  Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt" -OutFile $checksumsFile
  $checksums = Get-Content -Raw -LiteralPath $checksumsFile
  $entries = @($checksums -split '\r?\n' | Where-Object { $_ -match "^([0-9a-f]{64})  $([regex]::Escape($asset))$" })
  if ($entries.Count -ne 1) { throw 'Release checksum is missing or ambiguous' }
  $expected = ($entries[0] -split '  ')[0]
  $exe = Join-Path $tmp 'bbx.exe'
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $exe
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Binary checksum mismatch'
  }
  $env:BBX_AUTO_UPDATE = 'off'
  & $exe install-self --bin-dir $InstallDir --no-restart
  if ($LASTEXITCODE -ne 0) { throw 'Installation failed' }
  $installed = Join-Path $InstallDir 'bbx.exe'
  & $installed install $ExtensionId --browser $Browser
  if ($LASTEXITCODE -ne 0) { throw 'Browser registration failed' }
  & $installed restart
  if ($LASTEXITCODE -ne 0) { throw 'Daemon restart failed' }
  $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
  if (($userPath -split ';') -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('PATH', "$InstallDir;$userPath", 'User')
  }
  if (($env:Path -split ';') -notcontains $InstallDir) { $env:Path = "$InstallDir;$env:Path" }
  Write-Host "Installed Browser Bridge to $installed. Open a new terminal to use bbx."
} finally {
  $env:BBX_AUTO_UPDATE = $previousAutoUpdate
  Remove-Item -LiteralPath $tmp -Recurse -Force
}
