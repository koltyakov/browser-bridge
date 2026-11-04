import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { BridgeClient } from '../agent-client/src/client.js';
import { BridgeDaemon } from '../native-host/src/daemon.js';
import { silentLogger } from '../native-host/src/daemon-logger.js';
import type { BridgeTransport } from '../native-host/src/config.js';
import { withTempSocketPath } from '../../tests/_helpers/socketHarness.ts';

const v2Binary = process.env.BBX_TEST_V2_BINARY;
const execute = promisify(execFile);
const agentToken = 'a'.repeat(43);
const extensionToken = 'b'.repeat(43);

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForListener(child: ChildProcess, transport: BridgeTransport): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, 'isolated v2 daemon exited during startup');
    const reachable = await new Promise<boolean>((resolve) => {
      const socket =
        transport.type === 'tcp'
          ? net.createConnection({ host: transport.host, port: transport.port })
          : net.createConnection(transport.socketPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable) return;
    await delay(25);
  }
  assert.fail('isolated v2 daemon did not become ready');
}

// All homes, credentials and daemon endpoints in this matrix are disposable
// fixtures. Neither installed runtime nor browser registrations are changed.
for (const kind of ['local', 'tcp'] as const) {
  for (const direction of ['node-to-go', 'go-to-node'] as const) {
    test(
      `Node 1.15 / Go 2.0 ${direction} over ${kind}`,
      { skip: !v2Binary, timeout: 15000 },
      async () => {
        assert.ok(v2Binary);
        await withTempSocketPath(async ({ bridgeHome, socketPath }) => {
          const port = kind === 'tcp' ? await unusedPort() : null;
          const transport: BridgeTransport =
            port === null
              ? { type: 'socket', socketPath, label: socketPath }
              : { type: 'tcp', host: '127.0.0.1', port, label: `127.0.0.1:${port}` };
          const keys = [
            'BROWSER_BRIDGE_HOME',
            'BBX_TCP_PORT',
            'BBX_TCP_HOST',
            'BBX_TCP_BIND_HOST',
            'BBX_AUTH_TOKEN',
            'BBX_AUTH_TOKEN_FILE',
            'BBX_REMOTE',
            'BBX_AUTO_UPDATE',
          ];
          const saved = keys.map((key) => process.env[key]);
          keys.forEach((key) => {
            delete process.env[key];
          });
          process.env.BROWSER_BRIDGE_HOME = bridgeHome;
          process.env.BBX_AUTO_UPDATE = 'off';
          if (port !== null) process.env.BBX_TCP_PORT = String(port);
          try {
            // Legacy local Node daemons deliberately have no credential files.
            if (direction === 'node-to-go' || kind === 'tcp') {
              await fs.writeFile(path.join(bridgeHome, 'daemon.auth'), agentToken, { mode: 0o600 });
              await fs.writeFile(path.join(bridgeHome, 'daemon.extension.auth'), extensionToken, {
                mode: 0o600,
              });
            }
            if (direction === 'node-to-go') {
              const child = spawn(v2Binary, ['--bridge-daemon'], {
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              const stderr: Buffer[] = [];
              child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
              const client = new BridgeClient({
                transport,
                checkProtocolOnConnect: false,
                restartDaemonOnVersionMismatch: false,
                updateNpmOnCompatibleVersion: false,
              });
              try {
                await waitForListener(child, transport);
                await client.connect();
                const response = await client.request({ method: 'health.ping' });
                assert.equal(response.ok, true, Buffer.concat(stderr).toString());
                const health = response.result as { daemon?: string; daemonVersion?: string };
                assert.equal(health.daemon, 'ok');
                assert.match(health.daemonVersion || '', /^2\./u);
              } finally {
                await client.close();
                if (child.exitCode === null) {
                  const exited = once(child, 'exit');
                  child.kill();
                  await exited;
                }
              }
            } else {
              const daemon = new BridgeDaemon({
                transport,
                authToken: kind === 'tcp' ? agentToken : null,
                extensionAuthToken: kind === 'tcp' ? extensionToken : null,
                logger: silentLogger,
              });
              await daemon.start();
              try {
                const { stdout } = await execute(v2Binary, ['call', 'health.ping', '{}'], {
                  env: { ...process.env },
                  timeout: 5000,
                });
                const result: unknown = JSON.parse(stdout);
                assert.ok(result && typeof result === 'object' && 'daemon' in result);
                assert.equal(result.daemon, 'ok');
              } finally {
                await daemon.stop();
              }
            }
          } finally {
            keys.forEach((key, i) => {
              if (saved[i] === undefined) delete process.env[key];
              else process.env[key] = saved[i];
            });
          }
        });
      }
    );
  }
}
