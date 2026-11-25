import test from 'node:test';
import assert from 'node:assert/strict';

import { createRequest, MAX_SENSITIVE_VALUE_BYTES } from '../../../protocol/src/index.js';
import type { AccessSettings, BridgeRequest } from '../../../protocol/src/types.js';
import { DEFAULT_ACCESS_SETTINGS } from '../src/access-settings.js';
import {
  createSensitiveReadController,
  decodeResponseBody,
  isGatedSensitiveRequest,
} from '../src/background-sensitive-read.js';

const target = { tabId: 4, windowId: 7, title: 'Example', url: 'https://example.com/' };

function raw(body: string, base64Encoded: boolean, mimeType = 'application/json') {
  return { requestId: 'r-1', body, base64Encoded, mimeType };
}

function typedError(error: unknown) {
  return error as { code?: string; message?: string; details?: Record<string, unknown> };
}

test('a JSON body is returned whole with its MIME type and decoded size', () => {
  const body = '{"name":"café"}';
  assert.deepEqual(decodeResponseBody(raw(body, false), 'text', MAX_SENSITIVE_VALUE_BYTES), {
    source: 'response_body',
    requestId: 'r-1',
    body,
    encoding: 'text',
    mimeType: 'application/json',
    bytes: new TextEncoder().encode(body).byteLength,
    exact: true,
  });
  // Chrome base64-encodes some textual bodies; text mode still decodes them.
  const encoded = Buffer.from(body).toString('base64');
  assert.equal(
    decodeResponseBody(raw(encoded, true, 'text/plain; charset=utf-8'), 'text', 1024).body,
    body
  );
});

test('UTF-8 BOMs survive both CDP representations and requested encodings', () => {
  for (const body of ['\uFEFF', '\uFEFFX', '\uFEFFcafé', 'X\uFEFF']) {
    const bytes = Buffer.from(body, 'utf8');
    for (const mimeType of ['text/plain', 'application/json']) {
      for (const encoding of ['text', 'base64'] as const) {
        const plain = decodeResponseBody(raw(body, false, mimeType), encoding, 1024);
        const encoded = decodeResponseBody(
          raw(bytes.toString('base64'), true, mimeType),
          encoding,
          1024
        );
        assert.deepEqual(encoded, plain);
        assert.equal(encoded.body, encoding === 'text' ? body : bytes.toString('base64'));
        assert.equal(encoded.bytes, bytes.byteLength);
        assert.equal(encoded.exact, true);
      }
    }
  }
});

test('an oversize body rejects whole, in either encoding and before decoding', () => {
  const text = 'x'.repeat(MAX_SENSITIVE_VALUE_BYTES + 1);
  for (const [input, encoding] of [
    [raw(text, false), 'text'],
    [raw(text, false), 'base64'],
    [raw(Buffer.from(text).toString('base64'), true), 'text'],
    [raw(Buffer.from(text).toString('base64'), true), 'base64'],
  ] as const) {
    assert.throws(
      () => decodeResponseBody(input, encoding, MAX_SENSITIVE_VALUE_BYTES),
      (error: unknown) => {
        const typed = typedError(error);
        assert.equal(typed.code, 'RESULT_TOO_LARGE');
        assert.deepEqual(typed.details, {
          source: 'response_body',
          bytes: MAX_SENSITIVE_VALUE_BYTES + 1,
          maxBytes: MAX_SENSITIVE_VALUE_BYTES,
          mimeType: 'application/json',
          guidance: 'Partial bodies are never returned. Read a narrower request.',
        });
        assert.equal(JSON.stringify(error).includes('xxxx'), false, 'no partial body');
        return true;
      }
    );
  }
  assert.equal(
    decodeResponseBody(raw('x'.repeat(MAX_SENSITIVE_VALUE_BYTES), false), 'text', 262_144).bytes,
    MAX_SENSITIVE_VALUE_BYTES
  );
});

test('binary bodies need an explicit base64 request', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
  const input = raw(png.toString('base64'), true, 'image/png');
  assert.throws(
    () => decodeResponseBody(input, 'text', 1024),
    (error: unknown) => {
      const typed = typedError(error);
      assert.equal(typed.code, 'INVALID_REQUEST');
      assert.equal(typed.details?.reason, 'unsupported_encoding');
      assert.equal(typed.details?.mimeType, 'image/png');
      assert.equal(typed.details?.bytes, png.byteLength);
      return true;
    }
  );
  // A textual MIME type with invalid UTF-8 is still binary.
  assert.throws(
    () => decodeResponseBody(raw(png.toString('base64'), true, 'text/plain'), 'text', 1024),
    /encoding: "base64"/
  );
  const result = decodeResponseBody(input, 'base64', 1024);
  assert.equal(result.encoding, 'base64');
  assert.equal(result.body, png.toString('base64'));
  assert.equal(result.bytes, png.byteLength);
  const text = decodeResponseBody(raw('héllo', false, 'text/plain'), 'base64', 1024);
  assert.equal(Buffer.from(text.body, 'base64').toString('utf8'), 'héllo');
  assert.equal(text.bytes, 6);
});

/** A request as it arrives from the native host, before normalization. */
function wireRequest(params: Record<string, unknown>): BridgeRequest {
  return { id: 'wire', method: 'sensitive.read', params, meta: {} } as BridgeRequest;
}

test('only non-storage sensitive sources take the gated path', () => {
  const request = wireRequest;
  assert.equal(isGatedSensitiveRequest(request({ source: 'response_body', requestId: 'r' })), true);
  assert.equal(isGatedSensitiveRequest(request({ source: 'local_storage', key: 'k' })), false);
  assert.equal(isGatedSensitiveRequest(request({ source: 'session_storage', key: 'k' })), false);
  assert.equal(
    isGatedSensitiveRequest(createRequest({ id: 'y', method: 'page.get_state', params: {} })),
    false
  );
});

function controllerHarness(settings: Partial<AccessSettings> = {}) {
  const state = {
    accessSettings: { ...DEFAULT_ACCESS_SETTINGS, ...settings },
    accessSettingsRevision: '00000000-0000-4000-8000-000000000001',
  };
  const reads: string[] = [];
  let onRead = () => {};
  const controller = createSensitiveReadController({
    state,
    resolveRequestTarget: async () => target,
    isTargetStillGranted: async () => true,
    readers: {
      response_body: async (resolved, params) => {
        reads.push(`${resolved.tabId}:${params.requestId}:${params.encoding}`);
        onRead();
        return decodeResponseBody(raw('{"ok":true}', false), params.encoding, params.maxBytes);
      },
      indexeddb: async (resolved, params) => {
        reads.push(`${resolved.tabId}:indexeddb:${params.frameId}`);
        onRead();
        return {
          source: 'indexeddb',
          frameId: params.frameId,
          database: params.database,
          store: params.store,
          value: null,
          described: 0,
          bytes: 4,
          exact: true,
        };
      },
    },
  });
  return {
    state,
    reads,
    controller,
    setOnRead(callback: () => void) {
      onRead = callback;
    },
  };
}

const bodyRequest = () =>
  createRequest({
    id: 'body-read',
    method: 'sensitive.read',
    params: { source: 'response_body', requestId: 'r-1' },
  });

test('response body reads are denied by default with the standard policy denial', async () => {
  const { controller, reads, state } = controllerHarness({ allowIndexedDBReads: true });
  await assert.rejects(controller.handle(bodyRequest()), (error: unknown) => {
    const typed = typedError(error);
    assert.equal(typed.code, 'ACCESS_DENIED');
    assert.deepEqual(typed.details, {
      reason: 'policy_setting_disabled',
      setting: 'allowResponseBodyReads',
      dispatched: false,
      settings: { ...state.accessSettings },
      settingsRevision: state.accessSettingsRevision,
      source: 'response_body',
    });
    return true;
  });
  assert.deepEqual(reads, [], 'nothing is read while the setting is off');
});

test('an enabled setting reads the body, and turning it off mid-read discards the result', async () => {
  const harness = controllerHarness({ allowResponseBodyReads: true });
  const response = await harness.controller.handle(bodyRequest());
  assert.equal(response.ok, true);
  assert.deepEqual(response.ok && response.result, {
    source: 'response_body',
    requestId: 'r-1',
    body: '{"ok":true}',
    encoding: 'text',
    mimeType: 'application/json',
    bytes: 11,
    exact: true,
  });
  assert.deepEqual(harness.reads, ['4:r-1:text']);

  harness.setOnRead(() => {
    harness.state.accessSettings.allowResponseBodyReads = false;
  });
  await assert.rejects(harness.controller.handle(bodyRequest()), /disabled/);
});

test('unknown sources are rejected before the gate with the supported list', async () => {
  const { controller } = controllerHarness({ allowResponseBodyReads: true });
  await assert.rejects(controller.handle(wireRequest({ source: 'cache' })), (error: unknown) => {
    const typed = typedError(error);
    assert.equal(typed.code, 'INVALID_REQUEST');
    assert.deepEqual(typed.details?.supportedSources, [
      'local_storage',
      'session_storage',
      'response_body',
      'indexeddb',
    ]);
    return true;
  });
});

test('IndexedDB reads are denied before any reader runs while the setting is off', async () => {
  const { controller, reads } = controllerHarness({ allowResponseBodyReads: true });
  for (const params of [{ source: 'indexeddb', database: 'app', store: 'users', key: 1 }]) {
    await assert.rejects(controller.handle(wireRequest(params)), (error: unknown) => {
      const typed = typedError(error);
      assert.equal(typed.code, 'ACCESS_DENIED');
      assert.equal(typed.details?.reason, 'policy_setting_disabled');
      assert.equal(typed.details?.source, params.source);
      assert.match(String(typed.message), /IndexedDB records/);
      assert.equal(JSON.stringify(error).includes('sid'), false, 'no locator in the denial');
      return true;
    });
  }
  assert.deepEqual(reads, [], 'no IndexedDB open while off');
});

test('an uncertain gate state fails closed for the new sources', async () => {
  const harness = controllerHarness({ allowIndexedDBReads: true });
  for (const unsafe of [undefined, 'true', 1]) {
    Reflect.set(harness.state.accessSettings, 'allowIndexedDBReads', unsafe);
    await assert.rejects(
      harness.controller.handle(
        wireRequest({ source: 'indexeddb', database: 'app', store: 'users', key: 1 })
      ),
      /disabled/
    );
  }
  assert.deepEqual(harness.reads, []);
  harness.state.accessSettings.allowIndexedDBReads = true;
  const response = await harness.controller.handle(
    wireRequest({ source: 'indexeddb', database: 'app', store: 'users', key: [1, 'a'], frameId: 3 })
  );
  assert.equal(response.ok, true);
  assert.deepEqual(harness.reads, ['4:indexeddb:3']);
  // Turning the setting off while a read is in flight discards its result.
  harness.setOnRead(() => {
    harness.state.accessSettings.allowIndexedDBReads = false;
  });
  await assert.rejects(
    harness.controller.handle(
      wireRequest({ source: 'indexeddb', database: 'app', store: 'users', key: 1 })
    ),
    /disabled/
  );
});
