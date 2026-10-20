import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileStaging, assignBrowserFiles } from '../src/background-files.js';
import { FILE_TTL_MS, normalizeFileParams } from '../../protocol/src/files.js';

test('staging enforces ordering, ownership, completion, expiration, and release', () => {
  let now = 1000;
  const files = createFileStaging({ now: () => now });
  const first = files.stage({ name: 'a.txt', size: 3, data: 'YQ==' }, 'owner', 1);
  assert.equal(first.complete, false);
  assert.throws(() => files.resolve([first.transferId], 'other', 1), /another/);
  assert.throws(() => files.resolve([first.transferId], 'owner', 2), /another/);
  assert.throws(() => files.resolve([first.transferId], 'owner', 1), /Finish/);
  assert.throws(
    () => files.stage({ transferId: first.transferId, offset: 0, data: 'Yg==' }, 'owner', 1),
    /offset/
  );
  const last = files.stage({ transferId: first.transferId, offset: 1, data: 'YmM=' }, 'owner', 1);
  assert.equal(last.complete, true);
  assert.equal(
    new TextDecoder().decode(files.resolve([last.transferId], 'owner', 1)[0].bytes),
    'abc'
  );
  now += FILE_TTL_MS;
  assert.throws(() => files.resolve([last.transferId], 'owner', 1), /expired/);
  const empty = files.stage({ name: 'empty', size: 0 }, 'owner', 1);
  assert.equal(empty.complete, true);
  assert.equal(files.release(empty.transferId, 'owner', 1).released, true);
  assert.throws(() => files.resolve([empty.transferId], 'owner', 1));
});

test('file params reject malformed payloads before allocating or downloading', () => {
  for (const params of [
    { name: '../a', size: 1 },
    { name: 'a', size: 1.5 },
    { name: 'a', size: -1 },
    { name: 'a', size: 1, data: '!!' },
  ])
    assert.throws(() => normalizeFileParams('files.stage', params));
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'https://user:pass@example.com/a'])
    assert.throws(() => normalizeFileParams('download.resource', { url }));
  assert.throws(() => normalizeFileParams('input.set_files', { target: {}, files: [], paths: [] }));
  assert.throws(() =>
    normalizeFileParams('input.set_files', { target: { elementRef: 'el_1' }, paths: ['/tmp/a'] })
  );
  assert.throws(() =>
    normalizeFileParams('download.resource', {
      url: 'https://example.com',
      maxBytes: 100 * 1024 * 1024,
    })
  );
});

test('browser path assignment validates the exact input and never retries the mutation', async () => {
  const calls: string[] = [];
  const result = await assignBrowserFiles(
    async (method) => {
      calls.push(method);
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [2] };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'object' } };
      if (method === 'Runtime.callFunctionOn')
        return { result: { value: calls.includes('DOM.setFileInputFiles') ? 1 : true } };
      return {};
    },
    '#file',
    ['/browser/a.txt']
  );
  assert.equal(result.assigned, true);
  assert.equal(calls.filter((method) => method === 'DOM.setFileInputFiles').length, 1);
  assert.equal(calls.at(-1), 'Runtime.releaseObjectGroup');
});
