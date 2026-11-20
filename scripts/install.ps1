#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Version = '',
  # BEGIN GENERATED PARAMETERS
  [string]$ExtensionId = 'jjjkmmcdkpcgamlopogicbnnhdgebhie',
  [ValidateSet('', 'chrome', 'edge', 'brave', 'chromium', 'arc', 'chrome-beta', 'chrome-dev', 'chrome-canary', 'chrome-for-testing', 'vivaldi', 'opera')]
  # END GENERATED PARAMETERS
  [string]$Browser = '',
  [string]$InstallDir = (Join-Path $HOME '.local\bin'),
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Remove-LegacyNpmPackage {
  $volta = Get-Command volta -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($volta) {
    try {
      $voltaPackages = & $volta.Source list --format plain '@browserbridge/bbx' 2>$null
      if ($LASTEXITCODE -ne 0) { throw 'Could not list Volta packages' }
      if ($voltaPackages -match '^package @browserbridge/bbx@\S+ /') {
        Write-Warning 'Volta manages an existing @browserbridge/bbx installation. It has not been removed and may shadow the standalone CLI.'
        Write-Warning 'After installation, remove it manually with: volta uninstall @browserbridge/bbx'
        Write-Warning 'Then open a new terminal and run bbx --version to verify that the standalone CLI is selected.'
        return
      }
    } catch {
      Write-Warning 'Could not inspect Volta packages. Skipping automatic npm removal to avoid deleting a Volta-managed installation.'
      Write-Warning 'Check with: volta list --format plain @browserbridge/bbx. If installed, remove it manually with: volta uninstall @browserbridge/bbx'
      return
    }
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
}

function Get-PathWithInstallDirectory {
  param([string]$CurrentPath, [string]$Directory)
  $remaining = @($CurrentPath -split ';' | Where-Object { $_ -and $_ -ne $Directory })
  return (@($Directory) + $remaining) -join ';'
}

function Resolve-ReleaseLine {
  param([string]$ReleaseLine)
  $pattern = '^v' + [regex]::Escape($ReleaseLine) + '\.[0-9]+$'
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
  if ($null -eq $best) { throw "No published stable release found for $ReleaseLine.x" }
  Write-Host "Selected Browser Bridge v$best for $ReleaseLine.x"
  return $best.ToString()
}

function Save-VerifiedBinary {
  param([string]$Base, [string]$Asset, [string]$Directory, [switch]$Reuse)
  $checksumsFile = Join-Path $Directory 'checksums.txt'
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/checksums.txt" -OutFile $checksumsFile
  $checksums = Get-Content -Raw -LiteralPath $checksumsFile
  $entries = @($checksums -split '\r?\n' | Where-Object { $_ -match "^([0-9a-f]{64})  $([regex]::Escape($Asset))$" })
  if ($entries.Count -ne 1) { throw 'Release checksum is missing or ambiguous' }
  $expected = ($entries[0] -split '  ')[0]
  $exe = Join-Path $Directory 'bbx.exe'
  if (-not $Reuse -or -not (Test-Path -LiteralPath $exe) -or
      (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant() -ne $expected) {
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset" -OutFile $exe
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Binary checksum mismatch'
  }
  return $exe
}

function Get-BootstrapDetection {
  param([string]$Executable, [string]$Directory, [string]$ExtensionId)
  $savedHome = $env:BROWSER_BRIDGE_HOME
  $savedRemote = $env:BBX_REMOTE
  $savedAutoUpdate = $env:BBX_AUTO_UPDATE
  $savedExtensionId = $env:BROWSER_BRIDGE_EXTENSION_ID
  try {
    $env:BROWSER_BRIDGE_HOME = Join-Path $Directory 'detection'
    $env:BBX_REMOTE = ''
    $env:BBX_AUTO_UPDATE = 'off'
    $env:BROWSER_BRIDGE_EXTENSION_ID = $ExtensionId
    $raw = & $Executable update status 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Native profile discovery unavailable' }
    $status = ($raw -join "`n") | ConvertFrom-Json
    # Missing properties mean an older bootstrap, not proof that no extension exists.
    if ($null -eq $status.PSObject.Properties['installedExtensionVersion']) {
      throw 'Downloaded release does not support native profile discovery'
    }
    if ($null -ne $status.installedExtensionVersion -and $status.installedExtensionVersion -cnotmatch '^\d+\.\d+\.\d+$') {
      throw 'Invalid detected extension version'
    }
    if ($status.runningVersion -cnotmatch '^\d+\.\d+\.\d+$') { throw 'Invalid bootstrap version' }
    return $status
  } catch {
    Write-Warning 'Extension discovery is unavailable in the downloaded release; using latest stable.'
    return $null
  } finally {
    $env:BROWSER_BRIDGE_HOME = $savedHome
    $env:BBX_REMOTE = $savedRemote
    $env:BBX_AUTO_UPDATE = $savedAutoUpdate
    $env:BROWSER_BRIDGE_EXTENSION_ID = $savedExtensionId
  }
}

if ($Help) {
  Write-Host 'Install Browser Bridge from GitHub Releases. Automatically selects the newest installed extension release line, or latest stable when none is found. -Version overrides detection with latest, a major-minor line such as 2.0, or an exact version. Options: -ExtensionId, -Browser (registration override), -InstallDir.'
  return
}
if ($ExtensionId -cnotmatch '^[a-z]{32}$') { throw 'Invalid extension ID' }
$nativeArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
# BEGIN GENERATED PLATFORMS
switch ($nativeArch) {
  'ARM64' { $asset = 'bbx-windows-arm64.exe'; break }
  'AMD64' { $asset = 'bbx-windows-x64.exe'; break }
  default { throw 'Unsupported Windows architecture' }
}
# END GENERATED PLATFORMS
$base = 'https://github.com/koltyakov/browser-bridge/releases/latest/download'
if ($Version -and $Version -ne 'latest') {
  $Version = $Version -replace '^v', ''
  if ($Version -notmatch '^[0-9]+\.[0-9]+(\.[0-9]+([.-][a-zA-Z0-9.-]+)?)?$') { throw 'Invalid version' }
  if ($Version -match '^[0-9]+\.[0-9]+$') {
    $Version = Resolve-ReleaseLine $Version
  }
  $base = "https://github.com/koltyakov/browser-bridge/releases/download/v$Version"
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp | Out-Null
$previousAutoUpdate = $env:BBX_AUTO_UPDATE
$previousBrowser = $env:BBX_BROWSER
$previousExtensionId = $env:BROWSER_BRIDGE_EXTENSION_ID
try {
  $exe = Save-VerifiedBinary $base $asset $tmp
  if (-not $Version) {
    $detection = Get-BootstrapDetection $exe $tmp $ExtensionId
    if ($null -ne $detection -and $detection.installedExtensionVersion) {
      $releaseLine = ($detection.installedExtensionVersion -split '\.')[0..1] -join '.'
      Write-Host "Detected Browser Bridge extension v$($detection.installedExtensionVersion)"
      $Version = Resolve-ReleaseLine $releaseLine
      $base = "https://github.com/koltyakov/browser-bridge/releases/download/v$Version"
      $exe = Save-VerifiedBinary $base $asset $tmp -Reuse:($Version -eq $detection.runningVersion)
    } elseif ($null -ne $detection) {
      Write-Host 'Using latest stable Browser Bridge; no extension version was detected.'
    }
  }
  Remove-LegacyNpmPackage
  $env:BBX_AUTO_UPDATE = 'off'
  if ($Browser) { $env:BBX_BROWSER = $Browser }
  if ($PSBoundParameters.ContainsKey('ExtensionId')) { $env:BROWSER_BRIDGE_EXTENSION_ID = $ExtensionId }
  & $exe install-self --bin-dir $InstallDir --no-restart
  if ($LASTEXITCODE -ne 0) { throw 'Installation failed' }
  $installed = Join-Path $InstallDir 'bbx.exe'
  $registrationArgs = @('install')
  if ($PSBoundParameters.ContainsKey('ExtensionId')) { $registrationArgs += $ExtensionId }
  if ($Browser) { $registrationArgs += @('--browser', $Browser) }
  & $installed @registrationArgs
  if ($LASTEXITCODE -ne 0) { throw 'Browser registration failed' }
  & $installed restart
  if ($LASTEXITCODE -ne 0) { throw 'Daemon restart failed' }
  $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
  [Environment]::SetEnvironmentVariable('PATH', (Get-PathWithInstallDirectory $userPath $InstallDir), 'User')
  $env:Path = Get-PathWithInstallDirectory $env:Path $InstallDir
  Write-Host "Installed Browser Bridge to $installed. Open a new terminal to use bbx."
} finally {
  $env:BBX_AUTO_UPDATE = $previousAutoUpdate
  $env:BBX_BROWSER = $previousBrowser
  $env:BROWSER_BRIDGE_EXTENSION_ID = $previousExtensionId
  Remove-Item -LiteralPath $tmp -Recurse -Force
}
