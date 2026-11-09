import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ChromePipe, eventually } from '../_helpers/chromePipe.ts';

function pipe() {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output, cdp: new ChromePipe(input, output) };
}

test('Chrome pipe correlates split UTF-8 replies and coalesced events across sessions', async () => {
  const { input, output, cdp } = pipe();
  const request = once(input, 'data');
  const result = cdp.command('Target.getTargets', {}, 'session-1');
  const [sent] = await request;
  assert.equal(JSON.parse(String(sent).replace('\0', '')).sessionId, 'session-1');
  const event = once(cdp, 'ServiceWorker.workerVersionUpdated');
  const bytes = Buffer.from(
    '{"id":1,"result":{"title":"雪"}}\0{"method":"ServiceWorker.workerVersionUpdated","params":{"versions":[]},"sessionId":"session-1"}\0'
  );
  const split = bytes.indexOf(Buffer.from('雪')) + 1;
  output.write(bytes.subarray(0, split));
  output.write(bytes.subarray(split));
  assert.deepEqual(await result, { title: '雪' });
  assert.deepEqual(await event, [{ versions: [] }, 'session-1']);
  cdp.close();
});

test('Chrome pipe rejects protocol errors, timeouts, EOF, and commands after close', async () => {
  const { output, cdp } = pipe();
  const failed = assert.rejects(cdp.command('Invalid.method'), /not found/);
  output.write('{"id":1,"error":{"message":"not found"}}\0');
  await failed;
  await assert.rejects(cdp.command('Slow.method', {}, undefined, 10), /timed out/);
  output.write('{"id":2,"result":{}}\0'); // A late reply cannot revive the expired call.
  const closed = assert.rejects(cdp.command('Pending.method'), /pipe closed/);
  output.end();
  await closed;
  await assert.rejects(cdp.command('After.close'), /pipe closed/);
});

test('Chrome pipe fails pending calls on malformed input and stream errors', async () => {
  for (const malformed of [true, false]) {
    const { input, output, cdp } = pipe();
    const pending = assert.rejects(cdp.command('Pending.method'));
    if (malformed) output.write('not json\0');
    else input.destroy(new Error('broken pipe'));
    await pending;
  }
});

test('recovery probes retry failures, receive decreasing budgets, and fail the deadline', async () => {
  let attempts = 0;
  const budgets: number[] = [];
  assert.equal(
    await eventually('ready', 500, async (remaining) => {
      budgets.push(remaining);
      if (++attempts === 1) throw new Error('not ready');
      return 'ready';
    }),
    'ready'
  );
  assert(budgets[1] < budgets[0]);
  await assert.rejects(
    eventually('unavailable', 20, async () => {
      throw new Error('offline');
    }),
    {
      message: 'unavailable did not recover within 20ms',
      cause: new Error('offline'),
    }
  );
});
