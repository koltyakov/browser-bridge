import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('../../../scripts/install.ps1', import.meta.url));
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const available = spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']).status === 0;

// Restricted permits command text but rejects dot-sourcing .ps1 files. Load the
// unchanged installer as command text, as the documented Windows installer does.
// -Help defines the real helpers and returns before downloads or installation.
const loadInstallerHelpers = `
$policyBefore = Get-ExecutionPolicy -List | ConvertTo-Json -Compress
. ([scriptblock]::Create([System.IO.File]::ReadAllText($env:INSTALLER))) -Help
if ((Get-ExecutionPolicy -List | ConvertTo-Json -Compress) -ne $policyBefore) {
  throw 'Loading installer helpers changed execution policy'
}
`;

test('PowerShell bootstrap discovery is read-only, explicit-ID aware, and restores its environment', { skip: !available && 'PowerShell is not installed' }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-probe-ps-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `${loadInstallerHelpers}
$env:BROWSER_BRIDGE_HOME = 'protected-home'
$env:BBX_REMOTE = 'protected-remote'
$env:BBX_AUTO_UPDATE = 'compatible'
$env:BROWSER_BRIDGE_EXTENSION_ID = 'protected-id'
function Invoke-TestBootstrap {
  if (($args -join ' ') -ne 'update status') { throw 'Unexpected bootstrap command' }
  if ($env:BROWSER_BRIDGE_HOME -ne (Join-Path $env:PROBE_DIR 'detection')) { throw 'Probe was not isolated' }
  if ($env:BBX_AUTO_UPDATE -ne 'off' -or $env:BBX_REMOTE) { throw 'Probe could update or route remotely' }
  if ($env:BROWSER_BRIDGE_EXTENSION_ID -ne ('a' * 32)) { throw 'Lost extension ID override' }
  $global:LASTEXITCODE = 0
  if ($script:probeCase -eq 'failed') { $global:LASTEXITCODE = 1; return }
  if ($script:probeCase -eq 'legacy') { return '{"runningVersion":"9.0.0"}' }
  if ($script:probeCase -eq 'invalid') { return '{"runningVersion":"9.0.0","installedExtensionVersion":"bad"}' }
  if ($script:probeCase -eq 'none') { return '{"runningVersion":"9.0.0","installedExtensionVersion":null}' }
  return '{"runningVersion":"9.0.0","installedExtensionVersion":"2.3.0"}'
}
foreach ($caseName in @('installed','none','legacy','failed','invalid')) {
  $script:probeCase = $caseName
  $result = Get-BootstrapDetection 'Invoke-TestBootstrap' $env:PROBE_DIR ('a' * 32)
  if ($caseName -eq 'installed' -and $result.installedExtensionVersion -ne '2.3.0') { throw 'Missed installed extension' }
  if ($caseName -eq 'none' -and $null -ne $result.installedExtensionVersion) { throw 'Invented extension version' }
  if ($caseName -in @('legacy','failed','invalid') -and $null -ne $result) { throw 'Accepted unavailable discovery' }
  if ($env:BROWSER_BRIDGE_HOME -ne 'protected-home' -or $env:BBX_REMOTE -ne 'protected-remote' -or
      $env:BBX_AUTO_UPDATE -ne 'compatible' -or $env:BROWSER_BRIDGE_EXTENSION_ID -ne 'protected-id') {
    throw 'Probe changed caller environment'
  }
}
`], { encoding: 'utf8', env: { ...process.env, INSTALLER: installer, PROBE_DIR: directory } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PowerShell selection resolves the newest stable numeric patch across pages', { skip: !available && 'PowerShell is not installed' }, () => {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `${loadInstallerHelpers}
function Invoke-RestMethod {
  param($Uri)
  if ($Uri -match 'page=1$') {
    $entries = @(0..98 | ForEach-Object { [pscustomobject]@{tag_name="v9.0.$_";draft=$false;prerelease=$false} })
    $entries += [pscustomobject]@{tag_name='v2.3.9';draft=$false;prerelease=$false}
    return ,$entries
  }
  return ,@(
    [pscustomobject]@{tag_name='v2.3.12';draft=$false;prerelease=$false},
    [pscustomobject]@{tag_name='v2.3.99';draft=$false;prerelease=$true}
  )
}
if ((Resolve-ReleaseLine '2.3') -ne '2.3.12') { throw 'Wrong release selection' }
`], { encoding: 'utf8', env: { ...process.env, INSTALLER: installer } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test(
  'PowerShell installer prepends its directory and removes duplicate PATH entries',
  { skip: !available && 'PowerShell is not installed' },
  () => {
    const result = spawnSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${loadInstallerHelpers}
$directory = 'C:\\Users\\Test User\\.local\\bin'
foreach ($current in @('', 'C:\\Volta\\bin', "C:\\Volta\\bin;$directory;C:\\Other;$directory")) {
  $updated = Get-PathWithInstallDirectory $current $directory
  if (($updated -split ';')[0] -ne $directory) { throw 'Install directory must be first' }
  if (@($updated -split ';' | Where-Object { $_ -eq $directory }).Count -ne 1) { throw 'Duplicate install directory' }
  if ((Get-PathWithInstallDirectory $updated $directory) -ne $updated) { throw 'PATH update is not idempotent' }
}
`,
      ],
      { encoding: 'utf8', env: { ...process.env, INSTALLER: installer } }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
);

test(
  'PowerShell installer protects Volta packages and keeps ordinary npm cleanup',
  { skip: !available && 'PowerShell is not installed' },
  async (t) => {
    for (const scenario of ['installed', 'absent', 'cached', 'failed', 'no-volta']) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-installer-ps-'));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const legacy = path.join(directory, '@browserbridge/bbx');
      await fs.mkdir(legacy, { recursive: true });
      await fs.writeFile(path.join(legacy, 'package.json'), '{}');
      const result = spawnSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `${loadInstallerHelpers}
function Get-Command {
  param($Name, $CommandType, $ErrorAction)
  if ($Name -eq 'volta') {
    if ($env:SCENARIO -ne 'no-volta') { [pscustomobject]@{ Source = 'Invoke-TestVolta' } }
  } else { [pscustomobject]@{ Source = 'Invoke-TestNpm' } }
}
function Invoke-TestVolta {
  if (($args -join ' ') -ne 'list --format plain @browserbridge/bbx') { throw 'Unexpected Volta mutation' }
  Add-Content -LiteralPath $env:VOLTA_CALLS -Value ($args -join ' ')
  $global:LASTEXITCODE = 0
  switch ($env:SCENARIO) {
    'installed' { 'package @browserbridge/bbx@1.14.2 / bbx / node@22.0.0 npm@built-in (default)' }
    'cached' { 'package @browserbridge/bbx@1.14.2 (fetched)' }
    'failed' { $global:LASTEXITCODE = 1 }
  }
}
function Invoke-TestNpm {
  Add-Content -LiteralPath $env:NPM_CALLS -Value ($args -join ' ')
  $global:LASTEXITCODE = 0
  if (($args -join ' ') -eq 'root --global') { $env:NPM_ROOT }
  elseif (($args -join ' ') -eq 'uninstall --global @browserbridge/bbx') {
    Remove-Item -LiteralPath $env:LEGACY -Recurse -Force
  } else { throw 'Unexpected npm command' }
}
Remove-LegacyNpmPackage
`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            INSTALLER: installer,
            SCENARIO: scenario,
            NPM_ROOT: directory,
            LEGACY: legacy,
            NPM_CALLS: path.join(directory, 'npm-calls.txt'),
            VOLTA_CALLS: path.join(directory, 'volta-calls.txt'),
          },
        }
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      // Windows PowerShell wraps warning text to its host's output width.
      const output = result.stdout.replace(/\s+/gu, ' ');
      if (scenario === 'installed' || scenario === 'failed') {
        assert.match(output, /volta uninstall @browserbridge\/bbx/);
        assert.match(
          output,
          scenario === 'installed'
            ? /has not been removed and may shadow/
            : /Skipping automatic npm/
        );
        assert.equal(await fs.readFile(path.join(legacy, 'package.json'), 'utf8'), '{}');
        await assert.rejects(fs.access(path.join(directory, 'npm-calls.txt')));
      } else {
        assert.doesNotMatch(output, /volta uninstall/);
        await assert.rejects(fs.access(legacy));
        assert.deepEqual(
          (await fs.readFile(path.join(directory, 'npm-calls.txt'), 'utf8')).trim().split(/\r?\n/u),
          ['root --global', 'uninstall --global @browserbridge/bbx']
        );
      }
      if (scenario !== 'no-volta') {
        assert.equal(
          (await fs.readFile(path.join(directory, 'volta-calls.txt'), 'utf8')).trim(),
          'list --format plain @browserbridge/bbx'
        );
      }
    }
  }
);
