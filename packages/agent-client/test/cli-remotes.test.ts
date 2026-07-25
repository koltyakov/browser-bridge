import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BridgeDaemon } from '../../native-host/src/daemon.js';
import { getBridgeAuthTokenPath } from '../../native-host/src/auth-token.js';
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

test('bbx protocol describe is local-only and ignores ambient remote selection', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const rejected = await runCli({
      args: ['protocol', 'describe', 'dom.query', '--remote', 'vm-private'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    });
    const local = await runCli({
      args: ['protocol', 'describe', 'dom.query'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome, BBX_REMOTE: 'vm-private' },
    });

    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /--remote flag is not supported with "protocol"/u);
    assert.equal(local.status, 0);
    assert.equal((local.json as { method: string }).method, 'dom.query');
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

/** Reserve a free loopback port so proxy tests never collide with a real daemon. */
async function reserveLoopbackPort(): Promise<number> {
  const net = await import('node:net');
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Stop the daemon that `bbx proxy enable` started for an isolated bridge home.
 * The pid file is the only handle the CLI leaves behind for the test process.
 */
async function stopDaemonForBridgeHome(bridgeHome: string): Promise<void> {
  let pid: number | null = null;
  try {
    const raw = await fs.promises.readFile(path.join(bridgeHome, 'daemon.pid'), 'utf8');
    const parsed = Number.parseInt(raw.trim(), 10);
    pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return;
  }

  if (pid === null) return;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withProxyBridgeHome(
  callback: (context: { bridgeHome: string; env: NodeJS.ProcessEnv; port: number }) => Promise<void>
): Promise<void> {
  await withBridgeHome(async (bridgeHome) => {
    const port = await reserveLoopbackPort();
    const env = { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome };
    try {
      await callback({ bridgeHome, env, port });
    } finally {
      await stopDaemonForBridgeHome(bridgeHome);
    }
  });
}

function readProxyJson(bridgeHome: string): Promise<{
  enabled: boolean;
  port: number;
  bindHost: string;
  token: string;
}> {
  return fs.promises
    .readFile(path.join(bridgeHome, 'proxy.json'), 'utf8')
    .then((raw) => JSON.parse(raw));
}

test('bbx proxy enable persists config, mints a token, and prints tunnel setup', async () => {
  await withProxyBridgeHome(async ({ bridgeHome, env, port }) => {
    const result = await runCli({
      args: ['proxy', 'enable', '--port', String(port)],
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');

    const config = await readProxyJson(bridgeHome);
    assert.equal(config.enabled, true);
    assert.equal(config.port, port);
    assert.equal(config.bindHost, '127.0.0.1');
    assert.match(config.token, /^[0-9a-f-]{36}$/u);

    // The token file is what remote clients authenticate against.
    const tokenPath = getBridgeAuthTokenPath({ BROWSER_BRIDGE_HOME: bridgeHome });
    const savedToken = (await fs.promises.readFile(tokenPath, 'utf8')).trim();
    assert.equal(savedToken, config.token);

    if (os.platform() !== 'win32') {
      const [tokenStat, configStat] = await Promise.all([
        fs.promises.stat(tokenPath),
        fs.promises.stat(path.join(bridgeHome, 'proxy.json')),
      ]);
      assert.equal(tokenStat.mode & 0o777, 0o600);
      assert.equal(configStat.mode & 0o777, 0o600);
    }

    assert.match(result.stdout, new RegExp(`proxy enabled on 127\\.0\\.0\\.1:${port}\\.`, 'u'));
    assert.ok(result.stdout.includes(config.token));
    assert.match(result.stdout, /ssh -N -L/u);
    assert.match(result.stdout, new RegExp(`ssh -N -L ${port}:127\\.0\\.0\\.1:${port}`, 'u'));
    assert.match(result.stdout, /bbx remote add remote-bbx 127\.0\.0\.1:/u);
    assert.match(result.stdout, /Daemon: (started|restarted) \(pid \d+\)/u);
  });
});

test('bbx proxy enable is idempotent and keeps the existing token and port', async () => {
  await withProxyBridgeHome(async ({ bridgeHome, env, port }) => {
    const first = await runCli({ args: ['proxy', 'enable', '--port', String(port)], env });
    assert.equal(first.status, 0, first.stderr);
    const firstConfig = await readProxyJson(bridgeHome);

    // Re-run with no flags at all: settings and secret must survive.
    const second = await runCli({ args: ['proxy', 'enable'], env });
    assert.equal(second.status, 0, second.stderr);

    const secondConfig = await readProxyJson(bridgeHome);
    assert.equal(secondConfig.token, firstConfig.token);
    assert.equal(secondConfig.port, port);
    assert.equal(secondConfig.bindHost, '127.0.0.1');

    assert.match(second.stdout, /unchanged - already-configured clients keep working/u);
    assert.match(second.stdout, /--rotate-token to generate a new secret/u);
    // Re-running must not re-print setup instructions for an unchanged token.
    assert.doesNotMatch(second.stdout, /ssh -N -L/u);
  });
});

test('bbx proxy enable --rotate-token replaces the secret and re-prints setup', async () => {
  await withProxyBridgeHome(async ({ bridgeHome, env, port }) => {
    const first = await runCli({ args: ['proxy', 'enable', '--port', String(port)], env });
    assert.equal(first.status, 0, first.stderr);
    const firstConfig = await readProxyJson(bridgeHome);

    const rotated = await runCli({ args: ['proxy', 'enable', '--rotate-token'], env });
    assert.equal(rotated.status, 0, rotated.stderr);

    const rotatedConfig = await readProxyJson(bridgeHome);
    assert.notEqual(rotatedConfig.token, firstConfig.token);
    assert.match(rotatedConfig.token, /^[0-9a-f-]{36}$/u);
    assert.equal(rotatedConfig.port, port, 'rotation must not reset the configured port');

    const savedToken = (
      await fs.promises.readFile(
        getBridgeAuthTokenPath({ BROWSER_BRIDGE_HOME: bridgeHome }),
        'utf8'
      )
    ).trim();
    assert.equal(savedToken, rotatedConfig.token);

    assert.match(rotated.stdout, /rotated - update every configured client/u);
    assert.match(rotated.stdout, /ssh -N -L/u);
  });
});

test('bbx proxy enable --token adopts a caller-supplied secret', async () => {
  await withProxyBridgeHome(async ({ bridgeHome, env, port }) => {
    const result = await runCli({
      args: ['proxy', 'enable', '--port', String(port), '--token', TOKEN],
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    const config = await readProxyJson(bridgeHome);
    assert.equal(config.token, TOKEN);

    const savedToken = (
      await fs.promises.readFile(
        getBridgeAuthTokenPath({ BROWSER_BRIDGE_HOME: bridgeHome }),
        'utf8'
      )
    ).trim();
    assert.equal(savedToken, TOKEN);
  });
});

test('bbx proxy enable changes the port while preserving the token', async () => {
  await withProxyBridgeHome(async ({ bridgeHome, env, port }) => {
    const first = await runCli({ args: ['proxy', 'enable', '--port', String(port)], env });
    assert.equal(first.status, 0, first.stderr);
    const firstConfig = await readProxyJson(bridgeHome);

    const nextPort = await reserveLoopbackPort();
    const second = await runCli({ args: ['proxy', 'enable', '--port', String(nextPort)], env });
    assert.equal(second.status, 0, second.stderr);

    const secondConfig = await readProxyJson(bridgeHome);
    assert.equal(secondConfig.port, nextPort);
    assert.equal(secondConfig.token, firstConfig.token);
    assert.match(second.stdout, /unchanged - already-configured clients keep working/u);
  });
});

test('bbx proxy enable --bind-host with --unsafe-plaintext warns instead of tunneling', async () => {
  await withProxyBridgeHome(async ({ bridgeHome, env, port }) => {
    const result = await runCli({
      args: [
        'proxy',
        'enable',
        '--port',
        String(port),
        '--bind-host',
        '0.0.0.0',
        '--unsafe-plaintext',
      ],
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    const config = await readProxyJson(bridgeHome);
    assert.equal(config.bindHost, '0.0.0.0');

    assert.match(result.stdout, /WARNING: raw TCP is exposed without transport encryption\./u);
    assert.match(result.stdout, /bbx remote add remote-bbx /u);
    assert.doesNotMatch(result.stdout, /ssh -N -L/u);
  });
});

test('bbx proxy disable removes the config and reports the daemon transition', async () => {
  await withProxyBridgeHome(async ({ bridgeHome, env, port }) => {
    const enabled = await runCli({ args: ['proxy', 'enable', '--port', String(port)], env });
    assert.equal(enabled.status, 0, enabled.stderr);
    await fs.promises.access(path.join(bridgeHome, 'proxy.json'));

    const disabled = await runCli({ args: ['proxy', 'disable'], env });
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(disabled.stderr, '');
    assert.match(
      disabled.stdout,
      /^Browser Bridge proxy disabled\. Daemon (restarted|started)\.\n$/u
    );

    await assert.rejects(fs.promises.access(path.join(bridgeHome, 'proxy.json')), {
      code: 'ENOENT',
    });

    const status = await runCli({ args: ['proxy', 'status'], env });
    assert.equal(status.stdout, 'Browser Bridge proxy is disabled.\n');
  });
});

test('bbx proxy disable is safe when proxy mode was never enabled', async () => {
  await withProxyBridgeHome(async ({ bridgeHome, env }) => {
    const result = await runCli({ args: ['proxy', 'disable'], env });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Browser Bridge proxy disabled\./u);
    await assert.rejects(fs.promises.access(path.join(bridgeHome, 'proxy.json')), {
      code: 'ENOENT',
    });
  });
});

test('bbx proxy rejects unknown subcommands and enable flags', async () => {
  await withBridgeHome(async (bridgeHome) => {
    const env = { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome };

    const unknownSubcommand = await runCli({ args: ['proxy', 'bogus'], env });
    assert.equal(unknownSubcommand.status, 1);
    assert.match(unknownSubcommand.stderr, /Usage: bbx proxy <enable\|disable\|status>/u);

    const unknownFlag = await runCli({ args: ['proxy', 'enable', '--nope'], env });
    assert.equal(unknownFlag.status, 1);
    assert.match(unknownFlag.stderr, /Unknown proxy enable option "--nope"\./u);

    const missingBindHost = await runCli({ args: ['proxy', 'enable', '--bind-host'], env });
    assert.equal(missingBindHost.status, 1);
    assert.match(missingBindHost.stderr, /--bind-host requires a value\./u);

    const missingToken = await runCli({ args: ['proxy', 'enable', '--token'], env });
    assert.equal(missingToken.status, 1);
    assert.match(missingToken.stderr, /--token requires a value\./u);

    const badPort = await runCli({ args: ['proxy', 'enable', '--port', '70000'], env });
    assert.equal(badPort.status, 1);
    assert.match(badPort.stderr, /port must be an integer between 1 and 65535\./u);
  });
});
