// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createRuntimeContext } from '../../protocol/src/index.js';
import { BRIDGE_HOME_ENV, getLauncherFilename } from '../../native-host/src/config.js';
import { sanitizeOutput, stripAnsi } from '../src/cli-helpers.js';
import { SHORTCUT_COMMANDS } from '../src/command-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const cliPath = path.join(repoRoot, 'packages', 'agent-client', 'src', 'cli.js');
const packageJsonPath = path.join(repoRoot, 'package.json');

/**
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} [options]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runCli(args, options = undefined) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
}

/**
 * @param {import('node:child_process').SpawnSyncReturns<string>} result
 * @returns {any}
 */
function parseJsonStdout(result) {
  return JSON.parse(result.stdout.trim());
}

test('stripAnsi removes CSI and single-byte escape sequences', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripAnsi('prefix\u001b]suffix'), 'prefixsuffix');
  assert.equal(
    stripAnsi('before \u001b[1;32mgreen\u001b[0m and \u001b]alert after'),
    'before green and alert after'
  );
});

test('sanitizeOutput strips ANSI recursively without changing non-strings', () => {
  const input = {
    summary: '\u001b[31mboom\u001b[0m',
    list: ['ok', '\u001b[32mgreen\u001b[0m', { nested: 'x\u001b]y' }],
    count: 3,
    ready: true,
    empty: null,
  };

  assert.deepEqual(sanitizeOutput(input), {
    summary: 'boom',
    list: ['ok', 'green', { nested: 'xy' }],
    count: 3,
    ready: true,
    empty: null,
  });
});

test('cli prints usage and exits successfully when no command is provided', () => {
  const result = runCli([]);

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage: bbx <command> \[args\]/);
  assert.match(result.stdout, /Setup:/);
  assert.match(result.stdout, /Generic RPC:/);
});

test('cli --help enumerates shortcut commands', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  for (const definition of Object.values(SHORTCUT_COMMANDS)) {
    assert.match(
      result.stdout,
      new RegExp(definition.usage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  }
});

test('cli prints the package version', () => {
  const result = runCli(['--version']);
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), pkg.version);
});

test('cli skill command prints the runtime context JSON', () => {
  const result = runCli(['skill']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(parseJsonStdout(result), createRuntimeContext());
});

test('cli install forwards browser and extension id args to the native host installer', async () => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-install-home-'));
  const bridgeHome = path.join(tempHome, 'bridge-home');
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    LOCALAPPDATA: path.join(tempHome, 'AppData', 'Local'),
    [BRIDGE_HOME_ENV]: bridgeHome,
  };
  const manifestDir =
    process.platform === 'darwin'
      ? path.join(
          tempHome,
          'Library',
          'Application Support',
          'Microsoft Edge',
          'NativeMessagingHosts'
        )
      : process.platform === 'win32'
        ? path.join(
            tempHome,
            'AppData',
            'Local',
            'Microsoft',
            'Edge',
            'User Data',
            'NativeMessagingHosts'
          )
        : path.join(tempHome, '.config', 'microsoft-edge', 'NativeMessagingHosts');
  const manifestPath = path.join(manifestDir, 'com.browserbridge.browser_bridge.json');
  const launcherPath = path.join(bridgeHome, getLauncherFilename());

  try {
    const result = runCli(['install', '--browser', 'edge', extensionId], {
      encoding: 'utf8',
      env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(`Wrote ${manifestPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    );
    assert.match(
      result.stdout,
      new RegExp(`Wrote ${launcherPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    );
    assert.equal(result.stdout.includes('Used built-in Browser Bridge extension ID.'), false);

    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    assert.equal(manifest.path, launcherPath);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
    await fs.promises.access(launcherPath);
  } finally {
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
});

test('cli reports unknown commands with usage and a failing exit code', () => {
  const result = runCli(['not-a-command']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: not-a-command/);
  assert.match(result.stdout, /Usage: bbx <command> \[args\]/);
});

test('cli returns a JSON usage error for missing required command arguments', () => {
  const result = runCli(['tab-close']);
  const payload = parseJsonStdout(result);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.match(payload.summary, /ERROR: Usage: tab-close <tabId>/);
  assert.equal(payload.evidence, null);
});

test('cli strips ANSI escapes from JSON error output', () => {
  const result = runCli(['call', 'bad.\u001b[31mname\u001b[0m']);
  const payload = parseJsonStdout(result);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes('\u001b['), false);
  assert.equal(payload.ok, false);
  assert.match(payload.summary, /Unknown method "bad.name"/);
  assert.match(payload.summary, /Run bbx skill to see available methods/);
});
