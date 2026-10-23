#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Version = '',
  # BEGIN GENERATED PARAMETERS
  [string]$ExtensionId = 'jjjkmmcdkpcgamlopogicbnnhdgebhie',
  [ValidateSet('chrome', 'edge', 'brave', 'chromium', 'arc')]
  # END GENERATED PARAMETERS
  [string]$Browser = 'chrome',
  [string]$InstallDir = (Join-Path $HOME '.local\bin'),
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Help) {
  Write-Host 'Install Browser Bridge from GitHub Releases. -Version accepts a major-minor release line such as 2.0, or an exact version. Options: -ExtensionId, -Browser, -InstallDir.'
  return
}
if ($ExtensionId -cnotmatch '^[a-z]{32}$') { throw 'Invalid extension ID' }
$nativeArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
# BEGIN GENERATED PLATFORMS
switch ($nativeArch) {
  'AMD64' { $asset = 'bbx-windows-x64.exe'; break }
  default { throw 'Unsupported Windows architecture' }
}
# END GENERATED PLATFORMS
$base = 'https://github.com/koltyakov/browser-bridge/releases/latest/download'
if ($Version) {
  $Version = $Version -replace '^v', ''
  if ($Version -notmatch '^[0-9]+\.[0-9]+(\.[0-9]+([.-][a-zA-Z0-9.-]+)?)?$') { throw 'Invalid version' }
  if ($Version -match '^[0-9]+\.[0-9]+$') {
    $releaseLine = $Version
    $pattern = '^v' + [regex]::Escape($releaseLine) + '\.[0-9]+$'
    $best = $null
    $page = 1
    do {
      $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/koltyakov/browser-bridge/releases?per_page=100&page=$page"
      if ($releases -isnot [Array]) { throw 'Invalid GitHub release list' }
      foreach ($release in $releases) {
        if ($release.draft -eq $false -and $release.prerelease -eq $false -and $release.tag_name -cmatch $pattern) {
          $candidate = [version]$release.tag_name.Substring(1)
          if ($null -eq $best -or $candidate -gt $best) { $best = $candidate }
        }
      }
      $page++
    } while ($releases.Count -eq 100)
    if ($null -eq $best) { throw "No published stable release found for $releaseLine.x" }
    $Version = $best.ToString()
    Write-Host "Selected Browser Bridge v$Version for $releaseLine.x"
  }
  $base = "https://github.com/koltyakov/browser-bridge/releases/download/v$Version"
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
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
  # Prefer npm.cmd so a PowerShell execution policy cannot block npm.ps1.
  $npm = Get-Command npm.cmd, npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($npm) {
    try {
      $npmRoot = & $npm.Source root --global 2>$null
      if ($LASTEXITCODE -ne 0) { throw 'Could not locate the global npm package directory' }
      if (Test-Path -LiteralPath (Join-Path $npmRoot '@browserbridge\bbx\package.json')) {
        Write-Host 'Removing the legacy global npm package @browserbridge/bbx...'
        & $npm.Source uninstall --global '@browserbridge/bbx'
        if ($LASTEXITCODE -ne 0) { throw 'npm uninstall failed' }
      }
    } catch {
      Write-Warning "Could not check or remove the legacy npm package: $_. Run npm uninstall -g @browserbridge/bbx manually if it still shadows the standalone CLI. Continuing with standalone installation."
    }
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
