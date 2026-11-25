import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SENSITIVE_VALUE_BYTES } from '../../../protocol/src/index.js';
import type { NormalizedSensitiveIndexedDbReadParams } from '../../../protocol/src/types.js';
import {
  INDEXEDDB_FRAME_TIMEOUT_MS,
  collectIndexedDbFrames,
  createIndexedDbRecordReader,
} from '../src/background-indexeddb.js';
import { handleTabBoundRequest } from '../src/background-tab-bound.js';
import { createRequest } from '../../../protocol/src/index.js';

const target = { tabId: 4, windowId: 7, title: 'App', url: 'https://app.example/' };

function frameMetadata(origin: string, database: string) {
  return {
    type: 'indexeddb',
    origin,
    available: true,
    databases: [{ name: database, version: 1, stores: [], storeCount: 0 }],
    total: 1,
    incomplete: [],
  };
}

test('cross-origin frame metadata is reported under that frame, never merged', async () => {
  const sent: Array<{ frameId: number; timeoutMs: number }> = [];
  const result = await collectIndexedDbFrames(
    { type: 'bridge.execute', method: 'page.get_storage', params: { type: 'indexeddb' } },
    frameMetadata('https://app.example', 'top-db'),
    4,
    {
      listFrames: async () => [
        { frameId: 0, tag: 'aaaa' },
        { frameId: 3, tag: 'bbbb' },
        { frameId: 5, tag: 'cccc' },
      ],
      sendFrameMessage: async (_tabId, frameId, _message, timeoutMs) => {
        sent.push({ frameId, timeoutMs });
        if (frameId === 5) throw new Error('frame gone');
        return frameMetadata('https://widgets.test', 'widget-db');
      },
    }
  );
  const frame = (frameId: number, origin: string, database: string) => {
    const { type: _type, ...metadata } = frameMetadata(origin, database);
    return { frameId, ...metadata };
  };
  assert.deepEqual(result, {
    type: 'indexeddb',
    frames: [
      frame(0, 'https://app.example', 'top-db'),
      frame(3, 'https://widgets.test', 'widget-db'),
    ],
    incompleteFrames: [5],
  });
  assert.deepEqual(
    sent.map((entry) => entry.frameId),
    [3, 5],
    'child frames are asked directly'
  );
  assert.equal(sent[0].timeoutMs, INDEXEDDB_FRAME_TIMEOUT_MS);
});

test('page.get_storage indexeddb returns per-frame results through the tab-bound path', async () => {
  const messages: Array<{ frameId: number; method: unknown }> = [];
  const response = await handleTabBoundRequest(
    createRequest({ id: 'idb', method: 'page.get_storage', params: { type: 'indexeddb' } }),
    {
      resolveRequestTarget: async () => target,
      ensureContentScript: async () => {},
      handleScreenshot: async () => ({}),
      handleNativeInput: async () => ({}),
      sendTabMessage: async (_tabId, message) => {
        messages.push({ frameId: 0, method: message.method });
        return frameMetadata('https://app.example', 'top-db');
      },
      toFailureResponse: () => {
        throw new Error('unexpected failure');
      },
      contentScriptTimeoutMs: 5_000,
      frames: {
        listFrames: async () => [
          { frameId: 0, tag: 'aaaa' },
          { frameId: 9, tag: 'dddd' },
        ],
        getFrameForRef: async () => 0,
        sendFrameMessage: async (_tabId, frameId, message) => {
          messages.push({ frameId, method: message.method });
          return frameMetadata('https://other.test', 'frame-db');
        },
      },
    }
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  const result = response.ok
    ? (response.result as { frames: Array<Record<string, unknown>> })
    : null;
  assert.deepEqual(
    result?.frames.map((frame) => [frame.frameId, frame.origin]),
    [
      [0, 'https://app.example'],
      [9, 'https://other.test'],
    ]
  );
  assert.deepEqual(messages, [
    { frameId: 0, method: 'page.get_storage' },
    { frameId: 9, method: 'page.get_storage' },
  ]);
});

function readParams(
  overrides: Partial<NormalizedSensitiveIndexedDbReadParams> = {}
): NormalizedSensitiveIndexedDbReadParams {
  return {
    source: 'indexeddb',
    database: 'app',
    store: 'users',
    key: 1,
    frameId: 0,
    maxBytes: MAX_SENSITIVE_VALUE_BYTES,
    ...overrides,
  };
}

test('a record read targets the frame named by frameId, and an unknown frame is not found', async () => {
  const sent: Array<{ frameId: number; message: Record<string, unknown> }> = [];
  let ensured = 0;
  const read = createIndexedDbRecordReader({
    ensureContentScript: async () => {
      ensured += 1;
    },
    frames: {
      listFrames: async () => [
        { frameId: 0, tag: 'aaaa' },
        { frameId: 3, tag: 'bbbb' },
      ],
      sendFrameMessage: async (_tabId, frameId, message) => {
        sent.push({ frameId, message });
        return {
          source: 'indexeddb',
          database: 'app',
          store: 'users',
          value: { id: 1 },
          described: 0,
          bytes: 8,
          exact: true,
        };
      },
    },
  });
  const result = await read(target, readParams({ frameId: 3 }));
  assert.equal(result.frameId, 3);
  assert.deepEqual(result.value, { id: 1 });
  assert.equal(sent[0].frameId, 3);
  assert.equal(sent[0].message.method, 'indexeddb.read_record');
  assert.equal(ensured, 1);

  await assert.rejects(read(target, readParams({ frameId: 42 })), (error: unknown) => {
    const typed = error as { code: string; details: Record<string, unknown> };
    assert.equal(typed.code, 'SENSITIVE_TARGET_NOT_FOUND');
    assert.equal(typed.details.reason, 'frame_not_found');
    return true;
  });
  assert.equal(sent.length, 1, 'an unknown frame is never messaged');
});

test('content errors pass through only when typed; anything else is generic', async () => {
  const replies: unknown[] = [
    {
      error: {
        code: 'SENSITIVE_TARGET_NOT_FOUND',
        message: 'No record with that key exists in the store.',
        details: { source: 'indexeddb', reason: 'key_not_found' },
      },
    },
    { error: 'DOMException: store "secret-store-name" missing' },
    { error: { code: 'NOT_A_CODE', message: 'secret-store-name' } },
    { source: 'indexeddb', exact: false },
  ];
  const read = createIndexedDbRecordReader({
    ensureContentScript: async () => {},
    frames: {
      listFrames: async () => [{ frameId: 0, tag: null }],
      sendFrameMessage: async () => replies.shift(),
    },
  });
  await assert.rejects(read(target, readParams()), (error: unknown) => {
    const typed = error as { code: string; details: Record<string, unknown> };
    assert.equal(typed.code, 'SENSITIVE_TARGET_NOT_FOUND');
    assert.equal(typed.details.reason, 'key_not_found');
    return true;
  });
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(read(target, readParams()), (error: unknown) => {
      const typed = error as { code: string; message: string };
      assert.equal(typed.code, 'INTERNAL_ERROR');
      assert.equal(JSON.stringify(error).includes('secret-store-name'), false);
      assert.equal(typed.message.includes('secret-store-name'), false);
      return true;
    });
  }
});
