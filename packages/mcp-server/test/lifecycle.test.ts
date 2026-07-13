import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  restartRegisteredMcpProcesses,
  startMcpProcessControl,
  tryStartMcpProcessControl,
} from '../src/lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../../agent-client/src/cli.js');

test('restartRegisteredMcpProcesses requests a live MCP restart', async () => {
  const registryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-mcp-processes-'));
  let restartResolve: (() => void) | null = null;
  const restarted = new Promise<void>((resolve) => {
    restartResolve = resolve;
  });
  const control = await startMcpProcessControl({
    registryDir,
    onRestart: () => restartResolve?.(),
  });
  const registration = JSON.parse(await fs.promises.readFile(control.registrationPath, 'utf8')) as {
    port: number;
  };
  const idleSocket = net.createConnection({ host: '127.0.0.1', port: registration.port });

  try {
    await new Promise<void>((resolve, reject) => {
      idleSocket.once('connect', resolve);
      idleSocket.once('error', reject);
    });
    const result = await restartRegisteredMcpProcesses({ registryDir });

    assert.deepEqual(result, {
      registered: 1,
      restartRequested: 1,
      restartFailed: 0,
      staleRegistrationsRemoved: 0,
    });
    await restarted;
    await assert.rejects(fs.promises.access(control.registrationPath));
  } finally {
    idleSocket.destroy();
    await control.dispose();
    await fs.promises.rm(registryDir, { recursive: true, force: true });
  }
});

test('restartRegisteredMcpProcesses removes invalid and stopped-process registrations', async () => {
  const registryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-mcp-stale-'));
  const invalidPath = path.join(registryDir, 'invalid.json');
  const unreachablePath = path.join(registryDir, 'unreachable.json');

  try {
    await fs.promises.writeFile(invalidPath, '{}\n', 'utf8');
    await fs.promises.writeFile(
      unreachablePath,
      `${JSON.stringify({
        protocolVersion: 1,
        instanceId: 'stale',
        pid: 2_147_483_647,
        port: 1,
        token: 'not-running',
      })}\n`,
      'utf8'
    );

    const result = await restartRegisteredMcpProcesses({ registryDir, timeoutMs: 100 });

    assert.deepEqual(result, {
      registered: 2,
      restartRequested: 0,
      restartFailed: 0,
      staleRegistrationsRemoved: 2,
    });
    assert.deepEqual(await fs.promises.readdir(registryDir), []);
  } finally {
    await fs.promises.rm(registryDir, { recursive: true, force: true });
  }
});

test('restartRegisteredMcpProcesses preserves a live process after a control failure', async () => {
  const registryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-mcp-failed-'));
  const registrationPath = path.join(registryDir, 'live.json');
  try {
    await fs.promises.writeFile(
      registrationPath,
      `${JSON.stringify({
        protocolVersion: 1,
        instanceId: 'live',
        pid: process.pid,
        port: 1,
        token: 'not-listening',
      })}\n`,
      'utf8'
    );

    assert.deepEqual(await restartRegisteredMcpProcesses({ registryDir, timeoutMs: 100 }), {
      registered: 1,
      restartRequested: 0,
      restartFailed: 1,
      staleRegistrationsRemoved: 0,
    });
    await fs.promises.access(registrationPath);
  } finally {
    await fs.promises.rm(registryDir, { recursive: true, force: true });
  }
});

test('restartRegisteredMcpProcesses succeeds when no MCP registry exists', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-mcp-empty-'));
  try {
    assert.deepEqual(
      await restartRegisteredMcpProcesses({ registryDir: path.join(root, 'missing') }),
      {
        registered: 0,
        restartRequested: 0,
        restartFailed: 0,
        staleRegistrationsRemoved: 0,
      }
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('tryStartMcpProcessControl keeps MCP startup independent from control setup', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-mcp-blocked-'));
  const filePath = path.join(root, 'not-a-directory');
  try {
    await fs.promises.writeFile(filePath, 'blocked\n', 'utf8');
    assert.equal(
      await tryStartMcpProcessControl({ registryDir: path.join(filePath, 'registry') }),
      null
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('a managed MCP subprocess exits after an acknowledged restart request', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-mcp-subprocess-'));
  const registryDir = path.join(bridgeHome, 'mcp-processes');
  const child = spawn(process.execPath, [cliPath, 'mcp', 'serve'], {
    env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    await waitForRegistration(registryDir);
    const childExit = waitForChildExit(child);
    assert.deepEqual(await restartRegisteredMcpProcesses({ registryDir }), {
      registered: 1,
      restartRequested: 1,
      restartFailed: 0,
      staleRegistrationsRemoved: 0,
    });
    assert.deepEqual(await childExit, { code: 0, signal: null });
  } finally {
    child.kill();
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

async function waitForRegistration(registryDir: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fs.promises.readdir(registryDir)).some((entry) => entry.endsWith('.json'))) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for MCP process registration.');
}

function waitForChildExit(
  child: ReturnType<typeof spawn>
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
