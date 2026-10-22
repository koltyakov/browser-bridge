import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadController } from '../src/background-downloads.js';
import { pasteImage } from '../src/background-paste.js';
import { normalizeRequestParams } from '../../../protocol/src/index.js';

test('native download capabilities survive worker restart and isolate browser history and access scopes', async () => {
  let stored: Record<string, unknown> = {};
  const actions: string[] = [];
  const item = {
    id: 18,
    state: 'in_progress',
    bytesReceived: 30 * 1024 * 1024,
    totalBytes: 100 * 1024 * 1024,
    filename: '/Downloads/export.zip',
  };
  const deps = {
    storage: {
      async get() {
        return stored;
      },
      async set(value: Record<string, unknown>) {
        stored = value;
      },
    },
    downloads: {
      async download(options: Record<string, unknown>) {
        assert.equal(options.conflictAction, 'uniquify');
        actions.push('start');
        return 18;
      },
      async search(query: { id: number }) {
        assert.equal(query.id, 18);
        return [item];
      },
      async pause() {
        actions.push('pause');
      },
      async resume() {
        actions.push('resume');
      },
      async cancel() {
        actions.push('cancel');
        item.state = 'interrupted';
      },
    },
  } as unknown as Parameters<typeof createDownloadController>[0];
  const access = async () => {};
  const first = await createDownloadController(deps).call(
    'download.start',
    { url: 'https://example.test/export' },
    7,
    'access-1',
    access
  );
  assert.ok('downloadId' in first);
  const params = { downloadId: first.downloadId };
  const controller = createDownloadController(deps);
  await assert.rejects(controller.call('download.cancel', params, 8, 'access-1', access), /scope/);
  await assert.rejects(controller.call('download.cancel', params, 7, 'access-2', access), /scope/);
  await assert.rejects(
    controller.call('download.cancel', { downloadId: '18' }, 7, 'access-1', access),
    /unknown/
  );
  await assert.rejects(
    controller.call('download.release', params, 7, 'access-1', access),
    /Cancel or finish/
  );
  for (const method of ['download.pause', 'download.resume', 'download.cancel'])
    await controller.call(method, params, 7, 'access-1', access);
  assert.deepEqual(actions, ['start', 'pause', 'resume', 'cancel']);
  const released = await controller.call('download.release', params, 7, 'access-1', access);
  assert.equal('fileDeleted' in released && released.fileDeleted, false);
  await assert.rejects(
    controller.call('download.status', params, 7, 'access-1', access),
    /unknown/
  );
});

test('download validation rejects credentials, unsafe schemes and paths', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.test'])
    assert.throws(() => normalizeRequestParams('download.start', { url }));
  for (const filename of ['../a', '/a', 'C:\\a', '..'])
    assert.throws(() =>
      normalizeRequestParams('download.start', { url: 'https://example.test', filename })
    );
});

test('image paste uses a real clipboard and native paste only after focus revalidation', async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const commands: string[] = [];
  const send = async (method: string, params: Record<string, unknown>) => {
    commands.push(method);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 4 };
    if (method === 'Runtime.evaluate') {
      assert.equal(params.userGesture, true);
      assert.equal(params.contextId, 4);
      return { result: { value: true } };
    }
    if (params.type === 'keyDown') assert.deepEqual(params.commands, ['Paste']);
    return {};
  };
  let checks = 0;
  await assert.rejects(
    pasteImage(png, send, async () => {
      if (++checks === 2) throw new Error('Focus changed');
    }),
    /Focus changed/
  );
  assert.equal(commands.includes('Input.dispatchKeyEvent'), false);
  commands.length = 0;
  const result = await pasteImage(png, send, async () => {});
  assert.equal(result.clipboardChanged, true);
  assert.deepEqual(commands.slice(-2), ['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
  await assert.rejects(
    pasteImage(new Uint8Array(), send, async () => {}),
    /PNG/
  );
});
