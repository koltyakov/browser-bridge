$ErrorActionPreference = 'Stop'
$base = 'https://github.com/koltyakov/browser-bridge/releases/latest/download'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  Write-Host 'Downloading Browser Bridge...'
  $asset = 'bbx-windows-x64-baseline.exe'
  $binary = Join-Path $temporary $asset
  Invoke-WebRequest "$base/$asset" -OutFile $binary -UseBasicParsing
  $checksumsFile = Join-Path $temporary 'SHA256SUMS'
  Invoke-WebRequest "$base/SHA256SUMS" -UseBasicParsing -OutFile $checksumsFile
  $checksums = Get-Content -Raw $checksumsFile
  $expected = ($checksums -split "`n" | Where-Object { $_ -match "  $([regex]::Escape($asset))\s*$" }) -replace '\s+.*$', ''
  if (!$expected -or (Get-FileHash $binary -Algorithm SHA256).Hash -ne $expected) {
    throw 'Download verification failed. Your current installation has not changed.'
  }
  & $binary setup @args
  if ($LASTEXITCODE -ne 0) { throw 'Setup failed. Your existing settings have been kept.' }
} finally {
  Remove-Item -Recurse -Force $temporary
}
