import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFailure, createSuccess } from '../../protocol/src/index.js';
import { runCli } from '../../../tests/_helpers/runCli.ts';
import { bridgeServerWith } from '../../../tests/_helpers/socketHarness.ts';

test('bbx batch rejects malformed call entries without dispatching them', async () => {
  const bridgeServer = await bridgeServerWith({});

  try {
    const result = await runCli({
      args: ['batch', '[null,{}]'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = result.json as Array<{
      method: string;
      tabId: number | null;
      ok: boolean;
      error: { code: string; message: string };
      response: unknown;
    }>;

    assert.equal(result.status, 1);
    assert.equal(payload.length, 2);
    for (const item of payload) {
      assert.equal(item.method, '');
      assert.equal(item.tabId, null);
      assert.equal(item.ok, false);
      assert.deepEqual(item.error, {
        code: 'INVALID_REQUEST',
        message: 'Each batch call needs a method.',
      });
      assert.equal(item.response, null);
    }
    assert.deepEqual(
      bridgeServer.requests.map((request) => request.method),
      []
    );
  } finally {
    await bridgeServer.close();
  }
});

test('bbx screenshot resolves a selector and writes the decoded image', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-screenshot-'));
  const outputPath = path.join(directory, 'capture.png');
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const bridgeServer = await bridgeServerWith({
    'dom.query': (request) =>
      createSuccess(request.id, { nodes: [{ elementRef: 'el_screenshot' }] }),
    'screenshot.capture_element': (request) =>
      createSuccess(request.id, {
        image: `data:image/png;base64,${imageBytes.toString('base64')}`,
        rect: { x: 1, y: 2, width: 30, height: 40 },
        format: 'png',
        mimeType: 'image/png',
        complete: true,
        clipped: false,
      }),
  });

  try {
    const result = await runCli({
      args: ['screenshot', '.capture-target', outputPath],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome },
    });
    const payload = result.json as {
      ok: boolean;
      evidence: {
        savedTo: string;
        rect: Record<string, number>;
        format: string;
        complete: boolean;
        clipped: boolean;
      };
    };

    assert.equal(result.status, 0, result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.evidence.savedTo, outputPath);
    assert.deepEqual(payload.evidence.rect, { x: 1, y: 2, width: 30, height: 40 });
    assert.equal(payload.evidence.format, 'png');
    assert.equal(payload.evidence.complete, true);
    assert.equal(payload.evidence.clipped, false);
    assert.deepEqual(await fs.promises.readFile(outputPath), imageBytes);
    assert.deepEqual(
      bridgeServer.requests.map((request) => request.method),
      ['dom.query', 'screenshot.capture_element']
    );
    assert.deepEqual(bridgeServer.requests[1].params, {
      elementRef: 'el_screenshot',
      format: 'png',
      quality: null,
      delivery: 'artifact',
    });
  } finally {
    await bridgeServer.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('bbx screenshot downloads, verifies, and deletes artifact delivery', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-artifact-'));
  const outputPath = path.join(directory, 'capture.png');
  const imageBytes = Buffer.from('artifact-image-bytes');
  const artifactId = `art_${'b'.repeat(43)}`;
  const sha256 = createHash('sha256').update(imageBytes).digest('hex');
  const bridgeServer = await bridgeServerWith({
    'screenshot.capture_element': (request) =>
      createSuccess(request.id, {
        delivery: 'artifact',
        artifact: {
          artifactId,
          kind: 'screenshot',
          mimeType: 'image/png',
          byteLength: imageBytes.length,
          sha256,
          chunkSize: 196_608,
          chunkCount: 1,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        rect: { x: 1, y: 2, width: 3, height: 4, scale: 1 },
        dimensions: { width: 3, height: 4 },
        byteLength: imageBytes.length,
        format: 'png',
        mimeType: 'image/png',
        complete: true,
        clipped: false,
      }),
    'artifact.read': (request) =>
      createSuccess(request.id, {
        artifactId,
        data: imageBytes.toString('base64'),
        offset: 0,
        byteLength: imageBytes.length,
        nextOffset: null,
      }),
    'artifact.delete': (request) => createSuccess(request.id, { artifactId, deleted: true }),
  });
  try {
    const result = await runCli({
      args: ['screenshot', 'el_screenshot', outputPath],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(await fs.promises.readFile(outputPath), imageBytes);
    assert.deepEqual(
      bridgeServer.requests.map((request) => request.method),
      ['screenshot.capture_element', 'artifact.read', 'artifact.delete']
    );
  } finally {
    await bridgeServer.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('bbx screenshot reports bridge failures without writing a file', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-screenshot-fail-'));
  const outputPath = path.join(directory, 'capture.png');
  const bridgeServer = await bridgeServerWith({
    'screenshot.capture_element': (request) =>
      createFailure(request.id, 'INTERNAL_ERROR', 'Capture failed.'),
  });

  try {
    const result = await runCli({
      args: ['screenshot', 'el_screenshot', outputPath],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome },
    });
    const payload = result.json as { ok: boolean; summary: string };

    assert.equal(result.status, 1);
    assert.equal(payload.ok, false);
    assert.match(payload.summary, /INTERNAL_ERROR: Capture failed\./u);
    await assert.rejects(fs.promises.access(outputPath), { code: 'ENOENT' });
    assert.deepEqual(
      bridgeServer.requests.map((request) => request.method),
      ['screenshot.capture_element']
    );
  } finally {
    await bridgeServer.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('bbx intercept remove, list, and clear preserve tab routing', async () => {
  const bridgeServer = await bridgeServerWith({
    'network.intercept.remove': (request) => createSuccess(request.id, { removed: true }),
    'network.intercept.list': (request) => createSuccess(request.id, { rules: [] }),
    'network.intercept.clear': (request) => createSuccess(request.id, { cleared: 0 }),
  });

  try {
    const env = { ...process.env, BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome };
    const removeResult = await runCli({
      args: ['intercept', '--tab', '23', 'remove', 'rule-1'],
      env,
    });
    const listResult = await runCli({ args: ['intercept', '--tab', '23', 'list'], env });
    const clearResult = await runCli({ args: ['intercept', '--tab', '23', 'clear'], env });

    assert.equal(removeResult.status, 0, removeResult.stdout);
    assert.equal(listResult.status, 0, listResult.stdout);
    assert.equal(clearResult.status, 0, clearResult.stdout);
    const interceptRequests = bridgeServer.requests.filter((request) =>
      request.method.startsWith('network.intercept.')
    );
    assert.deepEqual(
      interceptRequests.map((request) => request.method),
      ['network.intercept.remove', 'network.intercept.list', 'network.intercept.clear']
    );
    assert.deepEqual(interceptRequests[0].params, { ruleId: 'rule-1' });
    assert.deepEqual(interceptRequests[1].params, {});
    assert.deepEqual(interceptRequests[2].params, {});
    assert.deepEqual(
      interceptRequests.map((request) => request.tab_id),
      [23, 23, 23]
    );
  } finally {
    await bridgeServer.close();
  }
});
