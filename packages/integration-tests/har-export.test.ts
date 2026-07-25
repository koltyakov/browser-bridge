import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ARTIFACT_CHUNK_BYTES, createSuccess } from '../protocol/src/index.js';
import { bridgeServerWith } from '../../tests/_helpers/socketHarness.ts';
import {
  connectFakeExtension,
  connectTestClient,
  startTestDaemon,
} from '../../tests/_helpers/daemonHarness.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.resolve(__dirname, '../agent-client/src/cli.js');

const VALID_HAR = {
  log: {
    version: '1.2',
    creator: { name: 'bbx-integration-test', version: '1.0.0' },
    pages: [],
    entries: [
      {
        startedDateTime: '2026-07-24T00:00:00.000Z',
        time: 12,
        request: { method: 'GET', url: 'https://example.com/api' },
        response: { status: 200 },
      },
    ],
  },
};

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('har export: inline HAR payload round-trips through the daemon', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);
    try {
      const responsePromise = client.request({
        method: 'network.export_har',
        params: { limit: 20, urlPattern: '*api*', delivery: 'inline' },
        meta: { source: 'cli' },
      });

      const forwarded = await extension.nextRequest();
      assert.equal(forwarded.method, 'network.export_har');
      assert.deepEqual(forwarded.params, {
        limit: 20,
        urlPattern: '*api*',
        delivery: 'inline',
      });

      extension.respondOk(forwarded, { delivery: 'inline', har: VALID_HAR });

      const response = await responsePromise;
      assert.equal(response.ok, true);
      const result = response.result as Record<string, unknown>;
      assert.equal(result.delivery, 'inline');
      assert.deepEqual(result.har, VALID_HAR);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});

test('har export: artifact delivery commits a readable HAR artifact', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);
    try {
      const payload = Buffer.from(JSON.stringify(VALID_HAR), 'utf8');
      const sha256 = createHash('sha256').update(payload).digest('hex');
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const artifactId = `art_${'h'.repeat(43)}`;

      const responsePromise = client.request({
        method: 'network.export_har',
        params: { limit: 50, delivery: 'artifact' },
        meta: { source: 'cli' },
      });

      const forwarded = await extension.nextRequest();
      assert.equal(forwarded.method, 'network.export_har');
      assert.equal(forwarded.params.delivery, 'artifact');

      extension.sendMessage({
        type: 'extension.artifact.begin',
        artifact: {
          requestId: forwarded.id,
          artifactId,
          kind: 'har',
          mimeType: 'application/json',
          byteLength: payload.length,
          sha256,
          chunkCount: 1,
          createdAt,
          expiresAt,
        },
      });
      extension.sendMessage({
        type: 'extension.artifact.chunk',
        artifact: { requestId: forwarded.id },
        artifactId,
        chunkIndex: 0,
        data: payload.toString('base64'),
      });
      extension.sendMessage({
        type: 'extension.artifact.commit',
        artifact: { requestId: forwarded.id },
        artifactId,
      });
      extension.respondOk(forwarded, {
        delivery: 'artifact',
        artifact: {
          artifactId,
          kind: 'har',
          mimeType: 'application/json',
          byteLength: payload.length,
          sha256,
          chunkSize: ARTIFACT_CHUNK_BYTES,
          chunkCount: 1,
          createdAt,
          expiresAt,
        },
      });

      const response = await responsePromise;
      assert.equal(response.ok, true);
      const result = response.result as Record<string, unknown>;
      assert.equal(result.delivery, 'artifact');
      const descriptor = result.artifact as Record<string, unknown>;
      assert.equal(descriptor.kind, 'har');
      assert.equal(descriptor.sha256, sha256);

      const read = await client.request({
        method: 'artifact.read',
        params: { artifactId, offset: 0 },
        meta: { source: 'cli' },
      });
      assert.equal(read.ok, true);
      const readResult = read.result as Record<string, unknown>;
      const bytes = Buffer.from(String(readResult.data), 'base64');
      assert.deepEqual(JSON.parse(bytes.toString('utf8')), VALID_HAR);

      const deleted = await client.request({
        method: 'artifact.delete',
        params: { artifactId },
        meta: { source: 'cli' },
      });
      assert.equal(deleted.ok, true);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});

test('har export: artifact delivery without a committed artifact is rejected', async () => {
  const ctx = await startTestDaemon();
  const extension = await connectFakeExtension(ctx);

  try {
    const client = await connectTestClient(ctx);
    try {
      const responsePromise = client.request({
        method: 'network.export_har',
        params: { delivery: 'artifact' },
        meta: { source: 'cli' },
      });

      const forwarded = await extension.nextRequest();
      extension.respondOk(forwarded, {
        delivery: 'artifact',
        artifact: {
          artifactId: `art_${'m'.repeat(43)}`,
          kind: 'har',
          mimeType: 'application/json',
          byteLength: 10,
          sha256: '0'.repeat(64),
          chunkSize: ARTIFACT_CHUNK_BYTES,
          chunkCount: 1,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });

      const response = await responsePromise;
      assert.equal(response.ok, false);
      assert.equal(response.error?.code, 'ARTIFACT_TRANSFER_INVALID');
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    extension.destroy();
    await ctx.stop();
  }
});

test(
  'har export: bbx har rejects an invalid inline HAR document',
  {
    skip:
      process.platform === 'win32' ? 'Unix socket daemon test is not applicable on Windows' : false,
  },
  async () => {
    const bridgeServer = await bridgeServerWith(
      {
        'network.export_har': (request) =>
          createSuccess(request.id, { delivery: 'inline', har: { notALog: true } }),
      },
      { prefix: 'bbx-it-har-cli-' }
    );

    try {
      const outputPath = path.join(bridgeServer.bridgeHome, 'export.har');
      const cliResult = await runCli(['har', '--delivery', 'inline', outputPath], {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      });

      assert.equal(cliResult.code, 1);
      assert.equal(cliResult.signal, null);
      const payload = JSON.parse(cliResult.stdout.trim());
      assert.equal(payload.ok, false);
      assert.match(String(payload.summary), /valid HAR 1\.2 document/);
      assert.equal(fs.existsSync(outputPath), false);
      assert.deepEqual(
        bridgeServer.requests.map((request) => request.method),
        ['network.export_har']
      );
      assert.deepEqual(bridgeServer.errors, []);
    } finally {
      await bridgeServer.close();
    }
  }
);
