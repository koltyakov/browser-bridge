import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchResourceInPage, cancelPageResources } from '../src/background-resource.js';

test('resource fetch enforces streaming byte limits without Content-Length', async () => {
  const previous = globalThis.fetch;
  let cancelled = false;
  try {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(20));
          },
          cancel() {
            cancelled = true;
          },
        })
      );
    const result = await fetchResourceInPage('https://example.com', 10, 1000);
    assert.ok('error' in result);
    assert.match(result.error, /exceeds/);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = previous;
  }
});

test('resource fetch preserves binary data and MIME type without returning a filesystem path', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options?.credentials, 'include');
      return new Response(new Uint8Array([0, 255, 128]), {
        headers: { 'content-type': 'image/png; charset=binary' },
      });
    };
    assert.deepEqual(await fetchResourceInPage('https://example.com', 10, 1000), {
      data: 'AP+A',
      mimeType: 'image/png',
      status: 200,
    });
    globalThis.fetch = async () => new Response('', { status: 403 });
    assert.match(
      ((await fetchResourceInPage('https://example.com', 10, 1000)) as { error: string }).error,
      /403/
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test('access cleanup aborts in-flight page resource fetches', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const result = fetchResourceInPage('https://example.com', 10, 1000);
    cancelPageResources();
    assert.deepEqual(await result, { error: 'aborted' });
  } finally {
    globalThis.fetch = previous;
  }
});
