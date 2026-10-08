import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WindowActionRouter } from '../src/window-actions.js';
import type { ClientSocket } from '../src/daemon.js';
import { clockController } from '../../../tests/_helpers/faultInjection.ts';

type Peer = ClientSocket & { writes: string[] };
type Message = {
  type?: string;
  requestId: string;
  ok?: boolean;
  error?: string;
  action?: string;
  windowId?: number;
  enabledAt?: number;
};

function peer(extensionId: string): Peer {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    __role: 'extension' as const,
    __extensionId: extensionId,
    __windowActions: true,
    __accessEnabled: true,
    __enabledWindow: { windowId: 7, title: 'Other page', enabledAt: 123 },
    writes: [] as string[],
  }) as unknown as Peer;
  socket.write = (chunk) => {
    socket.writes.push(String(chunk));
    return true;
  };
  return socket;
}

const request = {
  requestId: 'ui-request',
  action: 'focus',
  extensionId: 'edge',
  windowId: 7,
  enabledAt: 123,
};
const last = (socket: Peer): Message => JSON.parse(socket.writes.at(-1) ?? '{}') as Message;
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('window action router targets one browser and ignores forged acknowledgements', async () => {
  const source = peer('chrome');
  const target = peer('edge');
  const outsider = peer('other');
  const router = new WindowActionRouter(
    new Map([
      ['chrome', source],
      ['edge', target],
      ['other', outsider],
    ])
  );
  for (const action of ['focus', 'disable']) {
    const operation = router.request(source, { ...request, action });
    await flush();
    const command = last(target);
    assert.equal(command.type, 'extension.window_action.command');
    assert.equal(command.action, action);
    assert.equal(command.windowId, 7);
    assert.notEqual(command.requestId, request.requestId);
    router.result(outsider, { requestId: command.requestId, ok: true });
    assert.equal(router.pending.size, 1);
    router.result(target, { requestId: command.requestId, ok: true });
    await operation;
    assert.deepEqual(last(source), {
      type: 'extension.window_action.response',
      requestId: 'ui-request',
      ok: true,
    });
    assert.equal(router.pending.size, 0);
  }
  assert.equal(outsider.writes.length, 0);
});

test('window action router rejects stale grants, self targets, unsupported peers, and agent sockets', async () => {
  const source = peer('chrome');
  const target = peer('edge');
  const extensions = new Map([
    ['chrome', source],
    ['edge', target],
  ]);
  const router = new WindowActionRouter(extensions);
  for (const invalid of [
    {},
    { ...request, action: 'enable' },
    { ...request, extensionId: 'missing' },
    { ...request, extensionId: 'chrome' },
    { ...request, windowId: 8 },
    { ...request, enabledAt: 124 },
  ]) {
    await router.request(source, invalid);
    assert.equal(last(source).ok, false);
  }
  target.__windowActions = false;
  await router.request(source, request);
  assert.match(last(source).error ?? '', /Update/);
  target.__windowActions = true;
  target.__accessEnabled = false;
  await router.request(source, request);
  assert.match(last(source).error ?? '', /changed/);
  target.__accessEnabled = true;
  target.__enabledWindow = null;
  await router.request(source, request);
  assert.equal(last(source).ok, false);
  source.__windowActions = false;
  await router.request(source, request);
  assert.match(last(source).error ?? '', /Invalid/);
  source.__windowActions = true;
  extensions.delete('chrome');
  await router.request(source, request);
  assert.match(last(source).error ?? '', /Invalid/);
  const agent = peer('agent');
  Object.defineProperty(agent, '__role', { value: 'agent' });
  await router.request(agent, request);
  assert.match(last(agent).error ?? '', /Invalid/);
  assert.equal(target.writes.length, 0);
  assert.equal(router.pending.size, 0);
});

test('window actions settle on timeout, disconnect, shutdown, write errors, and target failure', async (t) => {
  const clock = clockController();
  t.mock.method(globalThis, 'setTimeout', clock.setTimeout);
  t.mock.method(globalThis, 'clearTimeout', clock.clearTimeout);
  const source = peer('chrome');
  const target = peer('edge');
  const router = new WindowActionRouter(
    new Map([
      ['chrome', source],
      ['edge', target],
    ])
  );
  const timedOut = router.request(source, request);
  await clock.runNext();
  await timedOut;
  assert.match(last(source).error ?? '', /did not respond/);
  const disconnected = router.request(source, request);
  router.disconnect(target);
  await disconnected;
  assert.match(last(source).error ?? '', /disconnected/);
  const shutdown = router.request(source, request);
  router.clear();
  await shutdown;
  assert.match(last(source).error ?? '', /stopped/);
  const failed = router.request(source, request);
  await flush();
  router.result(target, { requestId: last(target).requestId, ok: false, error: 'Window closed' });
  await failed;
  assert.match(last(source).error ?? '', /Window closed/);
  target.write = () => {
    throw new Error('Disconnected');
  };
  await router.request(source, request);
  assert.match(last(source).error ?? '', /disconnected/);
  assert.equal(router.pending.size, 0);
  assert.equal(await clock.runNext(), false, 'all completed operations clear their timers');
});

test('window action router bounds pending work per source', async () => {
  const source = peer('chrome');
  const target = peer('edge');
  const router = new WindowActionRouter(
    new Map([
      ['chrome', source],
      ['edge', target],
    ])
  );
  const operations = Array.from({ length: 16 }, (_, index) =>
    router.request(source, { ...request, requestId: `ui-${index}` })
  );
  await router.request(source, request);
  assert.match(last(source).error ?? '', /Too many/);
  assert.equal(router.pending.size, 16);
  router.clear();
  await Promise.all(operations);
  assert.equal(router.pending.size, 0);
});
