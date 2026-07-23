import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyConfiguredAutoUpdate,
  getAutoUpdatePolicy,
  getBridgeConfigPath,
  readBridgeConfig,
  setAutoUpdatePolicy,
  isMcpProcess,
  isBrowserBridgeProcess,
} from '../src/config.js';

async function withBridgeHome(callback: (bridgeHome: string) => Promise<void>): Promise<void> {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-config-test-'));
  try {
    await callback(bridgeHome);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
}

const CLI_ARGV = ['node', '/package/agent-client/src/cli.js', 'status'];

test('bridge config defaults auto-update to off', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const env = { BROWSER_BRIDGE_HOME: bridgeHome };
    assert.equal(getBridgeConfigPath(env), path.join(bridgeHome, 'config.json'));
    assert.deepEqual(await readBridgeConfig(env), { autoUpdate: 'off' });
  });
});

test('setAutoUpdatePolicy writes privately and preserves unknown fields', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const env = { BROWSER_BRIDGE_HOME: bridgeHome };
    const configPath = getBridgeConfigPath(env);
    await fs.promises.writeFile(configPath, '{"future":true}\n', 'utf8');

    assert.equal(await setAutoUpdatePolicy('compatible', env), configPath);
    assert.deepEqual(JSON.parse(await fs.promises.readFile(configPath, 'utf8')), {
      future: true,
      autoUpdate: 'compatible',
    });
    if (process.platform !== 'win32') {
      assert.equal((await fs.promises.stat(configPath)).mode & 0o777, 0o600);
    }
  });
});

test('bridge config refuses malformed JSON and invalid policies', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const env = { BROWSER_BRIDGE_HOME: bridgeHome };
    await fs.promises.writeFile(getBridgeConfigPath(env), '{bad', 'utf8');
    await assert.rejects(readBridgeConfig(env), /Cannot read/u);
    await assert.rejects(setAutoUpdatePolicy('invalid' as 'off', env), /must be "off"/u);
  });
});

test('configured auto-update enables health preflight and supports environment overrides', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const env = { BROWSER_BRIDGE_HOME: bridgeHome };
    await setAutoUpdatePolicy('compatible', env);

    assert.deepEqual(
      await applyConfiguredAutoUpdate({ checkProtocolOnConnect: false }, env, CLI_ARGV),
      {
        checkProtocolOnConnect: true,
        updateNpmOnCompatibleVersion: true,
        exitProcessOnNpmUpdate: false,
      }
    );
    assert.equal(await getAutoUpdatePolicy({ ...env, BBX_AUTO_UPDATE: 'off' }), 'off');
    assert.deepEqual(
      await applyConfiguredAutoUpdate(
        { checkProtocolOnConnect: false },
        { ...env, npm_command: 'exec' },
        CLI_ARGV
      ),
      { checkProtocolOnConnect: false }
    );
    assert.deepEqual(
      await applyConfiguredAutoUpdate({ updateNpmOnCompatibleVersion: false }, env, CLI_ARGV),
      { updateNpmOnCompatibleVersion: false }
    );
    assert.deepEqual(
      await applyConfiguredAutoUpdate(
        {
          transport: {
            type: 'tcp',
            host: 'remote.example',
            port: 9223,
            label: 'remote.example:9223',
          },
        },
        env,
        CLI_ARGV
      ),
      {
        transport: {
          type: 'tcp',
          host: 'remote.example',
          port: 9223,
          label: 'remote.example:9223',
        },
      }
    );
  });
});

test('isMcpProcess recognizes shipped MCP entry points', () => {
  assert.equal(isMcpProcess(['node', '/package/agent-client/src/cli.js', 'mcp', 'serve']), true);
  assert.equal(isMcpProcess(['node', '/package/mcp-server/src/bin.js']), true);
  assert.equal(isMcpProcess(['node', '/usr/local/bin/bbx-mcp']), true);
  assert.equal(isMcpProcess(['node', 'C:\\npm\\bbx-mcp.cmd']), true);
  assert.equal(isMcpProcess(['node', '/package/agent-client/src/cli.js', 'status']), false);
});

test('persisted auto-update applies only to shipped Browser Bridge processes', () => {
  assert.equal(isBrowserBridgeProcess(CLI_ARGV), true);
  assert.equal(isBrowserBridgeProcess(['node', '/usr/local/bin/bbx']), true);
  assert.equal(isBrowserBridgeProcess(['node', '/usr/local/bin/bbx-mcp']), true);
  assert.equal(isBrowserBridgeProcess(['node', '/consumer/app.js']), false);
});
