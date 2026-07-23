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

test('bbx har serializes inline HAR data to the default output path', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-har-inline-'));
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'Browser Bridge', version: '1.0' },
      entries: [],
    },
  };
  const bridgeServer = await bridgeServerWith({
    'network.export_har': (request) => createSuccess(request.id, { delivery: 'inline', har }),
  });

  try {
    const result = await runCli({
      args: [
        'har',
        '--tab',
        '7',
        '--limit',
        '25',
        '--url-pattern',
        '*api*',
        '--delivery',
        'inline',
      ],
      cwd: directory,
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome },
    });
    const outputPath = path.join(directory, 'browser-bridge.har');
    const payload = result.json as {
      ok: boolean;
      evidence: { savedTo: string; delivery: string };
    };

    assert.equal(result.status, 0, result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.evidence.savedTo, 'browser-bridge.har');
    assert.equal(payload.evidence.delivery, 'inline');
    assert.deepEqual(JSON.parse(await fs.promises.readFile(outputPath, 'utf8')), har);
    assert.equal(bridgeServer.requests.length, 1);
    assert.equal(bridgeServer.requests[0].method, 'network.export_har');
    assert.equal(bridgeServer.requests[0].tab_id, 7);
    assert.deepEqual(bridgeServer.requests[0].params, {
      limit: 25,
      urlPattern: '*api*',
      delivery: 'inline',
    });
  } finally {
    await bridgeServer.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('bbx har downloads, verifies, deletes, and atomically writes artifact delivery', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-har-artifact-'));
  const outputPath = path.join(directory, 'network.har');
  const harBytes = Buffer.from('{"log":{"version":"1.2","entries":[]}}\n');
  const firstChunk = harBytes.subarray(0, 16);
  const secondChunk = harBytes.subarray(16);
  const artifactId = `art_${'h'.repeat(43)}`;
  const sha256 = createHash('sha256').update(harBytes).digest('hex');
  const bridgeServer = await bridgeServerWith({
    'network.export_har': (request) =>
      createSuccess(request.id, {
        delivery: 'artifact',
        artifact: {
          artifactId,
          kind: 'har',
          mimeType: 'application/json',
          byteLength: harBytes.length,
          sha256,
          chunkSize: 196_608,
          chunkCount: 1,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    'artifact.read': (request) => {
      const offset = Number(request.params.offset);
      const bytes = offset === 0 ? firstChunk : secondChunk;
      return createSuccess(request.id, {
        artifactId,
        data: bytes.toString('base64'),
        offset,
        byteLength: bytes.length,
        nextOffset: offset === 0 ? firstChunk.length : null,
      });
    },
    'artifact.delete': (request) => createSuccess(request.id, { artifactId, deleted: true }),
  });

  try {
    const result = await runCli({
      args: ['har', '--delivery', 'artifact', outputPath],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome },
    });

    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(await fs.promises.readFile(outputPath), harBytes);
    assert.deepEqual(
      bridgeServer.requests.map((request) => request.method),
      ['network.export_har', 'artifact.read', 'artifact.read', 'artifact.delete']
    );
    assert.equal(
      bridgeServer.messages.filter(
        (message) =>
          message &&
          typeof message === 'object' &&
          (message as { type?: string }).type === 'register'
      ).length,
      1
    );
    const temporaryFiles = (await fs.promises.readdir(directory)).filter((name) =>
      name.endsWith('.tmp')
    );
    assert.deepEqual(temporaryFiles, []);
  } finally {
    await bridgeServer.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('bbx har rejects malformed inline and artifact documents without writing files', async () => {
  for (const delivery of ['inline', 'artifact'] as const) {
    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), `bbx-cli-har-invalid-${delivery}-`)
    );
    const outputPath = path.join(directory, 'invalid.har');
    const invalidBytes = Buffer.from('{"notLog":true}', 'utf8');
    const artifactId = `art_${delivery[0].repeat(43)}`;
    const bridgeServer = await bridgeServerWith({
      'network.export_har': (request) =>
        delivery === 'inline'
          ? createSuccess(request.id, { delivery, har: { notLog: true } })
          : createSuccess(request.id, {
              delivery,
              artifact: {
                artifactId,
                kind: 'har',
                mimeType: 'application/json',
                byteLength: invalidBytes.length,
                sha256: createHash('sha256').update(invalidBytes).digest('hex'),
                chunkSize: 196_608,
                chunkCount: 1,
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            }),
      'artifact.read': (request) =>
        createSuccess(request.id, {
          artifactId,
          data: invalidBytes.toString('base64'),
          offset: 0,
          byteLength: invalidBytes.length,
          nextOffset: null,
        }),
      'artifact.delete': (request) => createSuccess(request.id, { artifactId, deleted: true }),
    });
    try {
      const result = await runCli({
        args: ['har', '--delivery', delivery, outputPath],
        env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome },
      });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /valid HAR 1\.2 document/u);
      await assert.rejects(fs.promises.access(outputPath), { code: 'ENOENT' });
      if (delivery === 'artifact') {
        assert.deepEqual(
          bridgeServer.requests.map((request) => request.method),
          ['network.export_har', 'artifact.read', 'artifact.delete']
        );
      }
    } finally {
      await bridgeServer.close();
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
});

test('bbx har rejects invalid artifact JSON encodings', async () => {
  const cases = [
    { label: 'syntax', bytes: Buffer.from('{', 'utf8'), expected: /not valid JSON/u },
    { label: 'utf8', bytes: Buffer.from([0xff, 0xfe]), expected: /not valid UTF-8 JSON/u },
  ];
  for (const [index, fixture] of cases.entries()) {
    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), `bbx-cli-har-${fixture.label}-`)
    );
    const outputPath = path.join(directory, 'invalid.har');
    const artifactId = `art_${String(index).repeat(43)}`;
    const bridgeServer = await bridgeServerWith({
      'network.export_har': (request) =>
        createSuccess(request.id, {
          delivery: 'artifact',
          artifact: {
            artifactId,
            kind: 'har',
            mimeType: 'application/json',
            byteLength: fixture.bytes.length,
            sha256: createHash('sha256').update(fixture.bytes).digest('hex'),
            chunkSize: 196_608,
            chunkCount: 1,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      'artifact.read': (request) =>
        createSuccess(request.id, {
          artifactId,
          data: fixture.bytes.toString('base64'),
          offset: 0,
          byteLength: fixture.bytes.length,
          nextOffset: null,
        }),
      'artifact.delete': (request) => createSuccess(request.id, { artifactId, deleted: true }),
    });
    try {
      const result = await runCli({
        args: ['har', '--delivery', 'artifact', outputPath],
        env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome },
      });
      assert.equal(result.status, 1);
      assert.match(result.stdout, fixture.expected);
      await assert.rejects(fs.promises.access(outputPath), { code: 'ENOENT' });
      assert.deepEqual(
        bridgeServer.requests.map((request) => request.method),
        ['network.export_har', 'artifact.read', 'artifact.delete']
      );
    } finally {
      await bridgeServer.close();
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
});

test('bbx har requires a .har output extension before dispatch', async () => {
  const result = await runCli({ args: ['har', 'network.json'] });
  const payload = result.json as { ok: boolean; summary: string };

  assert.equal(result.status, 1);
  assert.equal(payload.ok, false);
  assert.match(payload.summary, /HAR output path must use the \.har extension/u);
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
