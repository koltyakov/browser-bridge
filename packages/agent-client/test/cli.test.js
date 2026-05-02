// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeContext } from '../../protocol/src/index.js';
import { sanitizeOutput, stripAnsi } from '../src/cli-helpers.js';
import { SHORTCUT_COMMANDS } from '../src/command-registry.js';
import { createInstallFs } from '../../../tests/_helpers/installFs.js';
import { runCli } from '../../../tests/_helpers/runCli.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const packageJsonPath = path.join(repoRoot, 'package.json');

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

test('cli prints usage and exits successfully when no command is provided', async () => {
  const result = await runCli({ args: [] });

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage: bbx <command> \[args\]/);
  assert.match(result.stdout, /Setup:/);
  assert.match(result.stdout, /Generic RPC:/);
});

test('cli --help enumerates shortcut commands', async () => {
  const result = await runCli({ args: ['--help'] });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  for (const definition of Object.values(SHORTCUT_COMMANDS)) {
    assert.match(
      result.stdout,
      new RegExp(definition.usage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  }
});

test('cli prints the package version', async () => {
  const result = await runCli({ args: ['--version'] });
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), pkg.version);
});

test('cli skill command prints the runtime context JSON', async () => {
  const result = await runCli({ args: ['skill'] });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.json, createRuntimeContext());
});

test('cli install forwards browser and extension id args to the native host installer', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-cli-install-home-' });
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

  try {
    const result = await runCli({
      args: ['install', '--browser', 'edge', extensionId],
      env: installFs.env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      new RegExp(
        `Wrote ${installFs.browserManifests.edge.manifestPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
      )
    );
    assert.match(
      result.stdout,
      new RegExp(`Wrote ${installFs.launcherPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    );
    assert.equal(result.stdout.includes('Used built-in Browser Bridge extension ID.'), false);

    const manifest = JSON.parse(
      await fs.promises.readFile(installFs.browserManifests.edge.manifestPath, 'utf8')
    );
    assert.equal(manifest.path, installFs.launcherPath);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
    await fs.promises.access(installFs.launcherPath);
  } finally {
    await installFs.cleanup();
  }
});

test('cli reports unknown commands with usage and a failing exit code', async () => {
  const result = await runCli({ args: ['not-a-command'] });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: not-a-command/);
  assert.match(result.stdout, /Usage: bbx <command> \[args\]/);
});

test('cli returns a JSON usage error for missing required command arguments', async () => {
  const result = await runCli({ args: ['tab-close'] });
  const payload = result.json;

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.match(payload.summary, /ERROR: Usage: tab-close <tabId>/);
  assert.equal(payload.evidence, null);
});

test('cli strips ANSI escapes from JSON error output', async () => {
  const result = await runCli({ args: ['call', 'bad.\u001b[31mname\u001b[0m'] });
  const payload = result.json;

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes('\u001b['), false);
  assert.equal(payload.ok, false);
  assert.match(payload.summary, /Unknown method "bad.name"/);
  assert.match(payload.summary, /Run bbx skill to see available methods/);
});
