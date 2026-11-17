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
        `
. $env:INSTALLER -Help
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
          `
. $env:INSTALLER -Help
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
      if (scenario === 'installed' || scenario === 'failed') {
        assert.match(result.stdout, /volta uninstall @browserbridge\/bbx/);
        assert.match(
          result.stdout,
          scenario === 'installed'
            ? /has not been removed and may shadow/
            : /Skipping automatic npm/
        );
        assert.equal(await fs.readFile(path.join(legacy, 'package.json'), 'utf8'), '{}');
        await assert.rejects(fs.access(path.join(directory, 'npm-calls.txt')));
      } else {
        assert.doesNotMatch(result.stdout, /volta uninstall/);
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
