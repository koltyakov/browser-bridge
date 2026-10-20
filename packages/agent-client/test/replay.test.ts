import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportReplay } from '../src/replay.js';
import { createSuccess } from '../../protocol/src/index.js';

test('replay retrieves journals across byte boundaries and retains response bodies and crash gaps', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-replay-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const text =
    [
      { kind: 'header' },
      { kind: 'event', event: { seq: 1, type: 'request', at: 15, tabId: 1 } },
      {
        kind: 'event',
        event: {
          seq: 2,
          type: 'click',
          at: 10,
          tabId: 1,
          origin: 'trusted-event',
          label: 'é</script>',
        },
      },
      { kind: 'body', body: { requestId: '1', data: 'example' } },
      { kind: 'frame', frame: { at: 10, data: 'YQ==' } },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n';
  const bytes = Buffer.from(text);
  const output = path.join(root, 'result.json');
  let calls = 0;
  const result = await exportReplay(
    async (method, params) => {
      calls++;
      assert.equal(method, 'session.journal_read');
      const offset = Number(params.offset),
        end = Math.min(bytes.length, offset + 7);
      return createSuccess('id', {
        offset,
        byteLength: end - offset,
        nextOffset: end < bytes.length ? end : null,
        totalBytes: bytes.length,
        data: bytes.subarray(offset, end).toString('base64'),
      });
    },
    `journal_${'a'.repeat(64)}`,
    output
  );
  assert.ok(calls > 1);
  assert.equal(result.frames, 1);
  assert.equal(result.gaps, 1);
  const saved = JSON.parse(await fs.readFile(output, 'utf8')) as {
    bodies: unknown[];
    events: Array<{ correlation?: { causality: boolean } }>;
  };
  assert.equal(saved.bodies.length, 1);
  assert.equal(saved.events[0].correlation?.causality, false);
  await exportReplay(
    async () => {
      throw new Error('Local rendering must not call the bridge');
    },
    output,
    path.join(root, 'result.html')
  );
  assert.doesNotMatch(await fs.readFile(path.join(root, 'result.html'), 'utf8'), /é<\/script>/);
});
