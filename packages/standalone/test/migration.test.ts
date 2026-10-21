import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { migrateCodexConfig, migrateCommand } from '../src/migration.js';
import { verifyUpdateManifest } from '../src/updater.js';
import { parseInstalledMcpConfig } from '../../agent-client/src/mcp-config.js';
import { addCompanionPath } from '../src/shell-setup.js';
import { execFileSync } from 'node:child_process';

test(
  'PATH setup is idempotent, preserves existing shell settings and quotes paths',
  { skip: process.platform === 'win32' },
  () => {
    const directory = "/Users/Test User's Home/Browser Bridge/companion";
    const before = '# my settings\nexport CUSTOM=keep\n';
    const updated = addCompanionPath(before, directory);
    assert.ok(updated.startsWith(before));
    assert.equal(addCompanionPath(updated, directory), updated);
    const output = execFileSync('/bin/sh', ['-c', `${updated}\nprintf '%s' "$PATH"`], {
      env: { PATH: '/old/npm/bin:/usr/bin:/bin' },
      encoding: 'utf8',
    });
    assert.equal(output, `${directory}:/old/npm/bin:/usr/bin:/bin`);
    const repeated = execFileSync('/bin/sh', ['-c', `${updated}\nprintf '%s' "$PATH"`], {
      env: { PATH: output },
      encoding: 'utf8',
    });
    assert.equal(repeated, output);
  }
);

test('migrated JSONC entries remain visible in agent setup status', () => {
  assert.equal(
    parseInstalledMcpConfig(
      'cursor',
      '// my settings\n{"mcpServers":{"browser-bridge":{"command":"/companion/bbx",},},}'
    ).configured,
    true
  );
});

test('npm migration keeps destinations and flags while replacing known entrypoints', () => {
  const executable = '/Users/Test User/Library/Application Support/Browser Bridge/companion/bbx';
  assert.deepEqual(migrateCommand(['bbx', '--remote', 'office', 'mcp', 'serve'], executable), [
    executable,
    '--remote',
    'office',
    'mcp',
    'serve',
  ]);
  assert.deepEqual(
    migrateCommand(
      ['node', '/old/node_modules/@browserbridge/bbx/packages/mcp-server/src/bin.js'],
      executable
    ),
    [executable, 'mcp', 'serve']
  );
  assert.deepEqual(migrateCommand(['C:\\npm\\bbx.cmd', 'mcp', 'serve'], executable), [
    executable,
    'mcp',
    'serve',
  ]);
  assert.deepEqual(migrateCommand(['bbx-mcp'], executable), [executable, 'mcp', 'serve']);
  assert.equal(migrateCommand(['custom-wrapper', 'bbx'], executable), null);
  assert.equal(migrateCommand(['node', '/unrelated/server.js'], executable), null);
});

test('Codex migration keeps flags, env tables, comments and unrelated servers', () => {
  const raw =
    '# my settings\n[mcp_servers."browser-bridge"]\ncommand = "bbx"\nargs = ["--remote", "office", "mcp", "serve"]\nenabled = false\n[mcp_servers."browser-bridge".env]\nBBX_REMOTE = "office"\n[mcp_servers.other]\ncommand = "other"\n';
  const migrated = migrateCodexConfig(raw, '/path with spaces/bbx');
  assert.equal(migrated, raw.replace('command = "bbx"', 'command = "/path with spaces/bbx"'));
  assert.equal(migrateCodexConfig(migrated, '/path with spaces/bbx'), migrated);
  assert.equal(
    migrateCodexConfig(raw.replace('command = "bbx"', 'command = "custom"'), '/bbx'),
    raw.replace('command = "bbx"', 'command = "custom"')
  );
});

test('update metadata requires the pinned key and rejects modified payloads or unsafe assets', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const manifest = {
    version: '1.15.0',
    protocolMajor: 1,
    assets: { 'bun-darwin-arm64': { name: 'bbx-darwin-arm64', sha256: 'a'.repeat(64), size: 123 } },
  };
  const text = JSON.stringify(manifest);
  const signature = sign(null, Buffer.from(text), privateKey).toString('base64');
  assert.deepEqual(verifyUpdateManifest(text, signature, key), manifest);
  assert.throws(
    () => verifyUpdateManifest(text.replace('1.15.0', '1.16.0'), signature, key),
    /signature/
  );
  assert.throws(() => verifyUpdateManifest(text, signature, ''), /signature/);
  manifest.assets['bun-darwin-arm64'].name = '../bad';
  const unsafe = JSON.stringify(manifest);
  assert.throws(
    () =>
      verifyUpdateManifest(
        unsafe,
        sign(null, Buffer.from(unsafe), privateKey).toString('base64'),
        key
      ),
    /asset/
  );
});
