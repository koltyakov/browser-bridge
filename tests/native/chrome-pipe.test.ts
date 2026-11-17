import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { ChromePipe, eventually } from '../_helpers/chromePipe.ts';
import {
  extensionLaunchArgs,
  fixtureAccessExpression,
  readyFixtureTab,
} from '../live/chaos-harness.ts';

test('fixture access waits for scoped acknowledgment and never retries a failed toggle', async () => {
  for (const fail of [false, true]) {
    const messages: Array<Record<string, unknown>> = [];
    let listener: (message: unknown) => void = () => {};
    let disconnects = 0;
    const port = {
      onMessage: {
        addListener(callback: (message: unknown) => void) {
          listener = callback;
        },
      },
      onDisconnect: { addListener() {} },
      disconnect() {
        disconnects++;
      },
      postMessage(message: Record<string, unknown>) {
        messages.push(message);
        queueMicrotask(() => {
          assert.equal(disconnects, 0, 'Port closed before access was confirmed');
          if (message.type === 'state.request') {
            listener({ type: 'state.sync', state: { currentTab: { tabId: 99, enabled: false } } });
            listener({ type: 'state.sync', state: { currentTab: { tabId: 42, enabled: false } } });
          } else {
            listener(
              fail
                ? { type: 'toggle.error', error: 'denied' }
                : { type: 'state.sync', state: { currentTab: { tabId: 42, enabled: true } } }
            );
          }
        });
      },
    };
    const result = runInNewContext(fixtureAccessExpression(42), {
      chrome: { runtime: { connect: () => port } },
      setTimeout,
      clearTimeout,
    }) as Promise<void>;
    if (fail) await assert.rejects(result, /denied/);
    else await result;
    assert.equal(disconnects, 1);
    assert.deepEqual(
      messages.map((message) => message.type),
      ['state.request', 'scope.set_enabled']
    );
  }
});

test('portable browser setup does not combine explicit CDP loading with rejected legacy switches', () => {
  assert.deepEqual(extensionLaunchArgs('/private/extension', true), [
    '--enable-unsafe-extension-debugging',
  ]);
  assert.deepEqual(extensionLaunchArgs('/private/extension', false), [
    '--load-extension=/private/extension',
    '--disable-extensions-except=/private/extension',
  ]);
});

test('fixture setup waits for its owned tab to finish loading without choosing a duplicate', () => {
  const url = 'http://127.0.0.1:1234/';
  const first = { id: 1, url, status: 'complete' };
  const pending = { id: 2, url, status: 'loading' };
  assert.throws(() => readyFixtureTab([first, pending], url, 2), /not ready/);
  assert.throws(() => readyFixtureTab([first], url, 2), /not ready/);
  assert.throws(() =>
    readyFixtureTab([{ ...pending, status: 'complete', url: 'about:blank' }], url, 2)
  );
  assert.equal(readyFixtureTab([first, { ...pending, status: 'complete' }], url, 2), 2);
  assert.equal(readyFixtureTab([first], url), 1);
});

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
