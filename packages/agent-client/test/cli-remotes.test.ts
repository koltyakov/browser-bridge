import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BridgeDaemon } from '../../native-host/src/daemon.js';
import { runCli } from '../../../tests/_helpers/runCli.ts';
import type { AddressInfo } from 'node:net';
import type { BridgeTransport } from '../../native-host/src/config.js';

const TOKEN = '6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237';

async function withBridgeHome(callback: (bridgeHome: string) => Promise<void>): Promise<void> {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-remotes-test-'));
  try {
    await callback(bridgeHome);
  } finally {
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
}

test('bbx remote add defaults omitted port to 9223 and list redacts tokens', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const env = { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome };
    const addResult = await runCli({
      args: ['remote', 'add', 'vm-private', '10.0.0.5', '--token', TOKEN],
      env,
    });

    assert.equal(addResult.status, 0);
    assert.equal(addResult.stderr, '');
    assert.equal(addResult.stdout, 'Remote destination "vm-private" saved (10.0.0.5:9223).\n');

    const listResult = await runCli({ args: ['remote', 'list'], env });
    assert.equal(listResult.status, 0);
    assert.equal(listResult.stderr, '');
    assert.equal(listResult.stdout, 'vm-private\t10.0.0.5:9223\n');
    assert.equal(listResult.stdout.includes(TOKEN), false);
  });
});

test('bbx remote add accepts explicit port and remove deletes the destination', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const env = { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome };
    const addResult = await runCli({
      args: ['remote', 'add', 'vm-private', 'vm.internal:9443', '--token', TOKEN],
      env,
    });
    assert.equal(addResult.status, 0);
    assert.equal(addResult.stderr, '');
    assert.equal(addResult.stdout, 'Remote destination "vm-private" saved (vm.internal:9443).\n');

    const removeResult = await runCli({ args: ['remote', 'remove', 'vm-private'], env });
    assert.equal(removeResult.status, 0);
    assert.equal(removeResult.stderr, '');
    assert.equal(removeResult.stdout, 'Remote destination "vm-private" removed.\n');
  });
});

test('bbx remote add reads and validates --token-file without exposing the token in argv', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const tokenFile = path.join(bridgeHome, 'input.token');
    await fs.promises.writeFile(tokenFile, `${TOKEN}\n`, 'utf8');
    const env = { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome };
    const result = await runCli({
      args: ['remote', 'add', 'vm-private', '127.0.0.1:9223', '--token-file', tokenFile],
      env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const config = JSON.parse(
      await fs.promises.readFile(path.join(bridgeHome, 'remotes.json'), 'utf8')
    );
    assert.equal(config.remotes[0].token, TOKEN);

    await fs.promises.writeFile(tokenFile, 'invalid\n', 'utf8');
    const invalid = await runCli({
      args: ['remote', 'add', 'bad', '127.0.0.1:9223', '--token-file', tokenFile],
      env,
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Bridge auth token/u);
  });
});

test('bbx proxy status reports disabled config without starting a daemon', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const result = await runCli({
      args: ['proxy', 'status'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'Browser Bridge proxy is disabled.\n');
  });
});

test('bbx --remote rejects unknown destinations with a friendly error', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const result = await runCli({
      args: ['tabs', '--remote', 'nope'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    });

    assert.equal(result.status, 1);
    const parsed = result.json as { ok: boolean; summary: string };
    assert.equal(parsed.ok, false);
    assert.match(parsed.summary, /Unknown Browser Bridge destination "nope"/u);
  });
});

test('bbx --remote requires a destination name', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const result = await runCli({
      args: ['tabs', '--remote'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--remote requires a destination name/u);
  });
});

test('bbx --remote is rejected for local-only commands', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const result = await runCli({
      args: ['proxy', 'status', '--remote', 'vm-private'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--remote flag is not supported with "proxy"/u);
  });
});

test('BBX_REMOTE env is ignored for local-only commands', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const result = await runCli({
      args: ['proxy', 'status'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome, BBX_REMOTE: 'vm-private' },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'Browser Bridge proxy is disabled.\n');
  });
});

test('bbx remote add without --token prints a usage error instead of a stack trace', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const result = await runCli({
      args: ['remote', 'add', 'vm-private', '10.0.0.5'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    });

    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      'Usage: bbx remote add <name> <host:port> (--token <token>|--token-file <path>)\n'
    );
  });
});

test('bbx status --remote and BBX_REMOTE reach a token-authenticated TCP daemon', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const daemon = new BridgeDaemon({
      transport: {
        type: 'tcp',
        host: '127.0.0.1',
        port: 0,
        label: '127.0.0.1:0',
      } satisfies BridgeTransport,
      listenOptions: { host: '127.0.0.1', port: 0 },
      logger: { log() {}, error() {} },
      authToken: TOKEN,
    });
    await daemon.start();
    try {
      const { port } = daemon.serverAddress as AddressInfo;
      await fs.promises.writeFile(
        path.join(bridgeHome, 'remotes.json'),
        JSON.stringify({ remotes: [{ id: 'vm', host: '127.0.0.1', port, token: TOKEN }] }),
        'utf8'
      );
      const env = { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome };

      const flagResult = await runCli({ args: ['status', '--remote', 'vm'], env });
      assert.equal(flagResult.status, 0, flagResult.stderr);
      assert.equal((flagResult.json as { ok: boolean }).ok, true);

      const envResult = await runCli({ args: ['status'], env: { ...env, BBX_REMOTE: 'vm' } });
      assert.equal(envResult.status, 0, envResult.stderr);
      assert.equal((envResult.json as { ok: boolean }).ok, true);
    } finally {
      await daemon.stop();
    }
  });
});

test('bbx proxy enable rejects combining --token with --rotate-token', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const result = await runCli({
      args: ['proxy', 'enable', '--token', TOKEN, '--rotate-token'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    });

    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'Use either --token or --rotate-token, not both.\n');
  });
});

test('bbx proxy enable rejects non-loopback binds without unsafe plaintext acknowledgement', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const result = await runCli({
      args: ['proxy', 'enable', '--bind-host', '0.0.0.0'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--unsafe-plaintext/u);
    assert.match(result.stderr, /unencrypted.*SSH tunnel/u);
    await assert.rejects(fs.promises.access(path.join(bridgeHome, 'proxy.json')), {
      code: 'ENOENT',
    });
  });
});

test('bbx proxy status reports enabled config and daemon reachability', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await fs.promises.writeFile(
      path.join(bridgeHome, 'proxy.json'),
      JSON.stringify({ enabled: true, port: 65534, bindHost: '0.0.0.0' }),
      'utf8'
    );

    const result = await runCli({
      args: ['proxy', 'status'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      [
        'Browser Bridge proxy is enabled on 0.0.0.0:65534.',
        `Config: ${path.join(bridgeHome, 'proxy.json')}`,
        'Daemon: not reachable on 127.0.0.1:65534',
        '',
      ].join('\n')
    );
  });
});
