import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionUpdateController } from '../src/background-extension-update.js';
import { createStorageArea } from '../../../tests/_helpers/chromeFake.ts';

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function fixture(t: TestContext) {
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay: number) => {
    timers.set(++nextTimer, { callback, delay });
    return nextTimer as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  t.mock.method(globalThis, 'clearTimeout', ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(Number(id));
  }) as typeof clearTimeout);
  const calls = { checks: 0, reloads: 0, busy: false, now: 1_000_000, connected: true };
  const errors: unknown[] = [];
  const sent: Record<string, unknown>[] = [];
  const response: { status: string; version?: string } = { status: 'no_update' };
  const storage = createStorageArea();
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '2.2.1' }),
      async requestUpdateCheck() {
        calls.checks++;
        return response;
      },
      reload() {
        calls.reloads++;
      },
    },
    storage: { local: storage },
    management: {
      async getSelf() {
        return { installType: 'normal' };
      },
    },
  };
  const deps = {
    enabled: true,
    send(message: Record<string, unknown>) {
      if (!calls.connected) return false;
      sent.push(message);
      return true;
    },
    isBusy: () => calls.busy,
    reportError: (error: unknown) => errors.push(error),
    now: () => calls.now,
  };
  const controller = createExtensionUpdateController(chrome, deps);
  return {
    chrome,
    deps,
    calls,
    errors,
    sent,
    response,
    controller,
    signal: () => controller.handleMessage({ type: 'host.update_check', version: '2.3.0' }),
    tick(delay = 1_000) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `No timer at ${delay}ms`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

test('store update checks are drift-triggered and stay throttled across worker restarts', async (t) => {
  const f = fixture(t);
  assert.equal(f.controller.handleMessage({ type: 'unrelated' }), false);
  f.controller.handleMessage({ type: 'host.update_check', version: 'invalid' });
  f.controller.handleMessage({ type: 'host.update_check', version: '2.1.0' });
  await flush();
  assert.equal(f.calls.checks, 0);
  f.signal();
  f.signal();
  await flush();
  assert.equal(f.calls.checks, 1);
  const restarted = createExtensionUpdateController(f.chrome, f.deps);
  restarted.handleMessage({ type: 'host.update_check', version: '2.3.0' });
  await flush();
  assert.equal(f.calls.checks, 1);
  f.calls.now += 25 * 60 * 60_000;
  restarted.handleMessage({ type: 'host.update_check', version: '2.3.0' });
  await flush();
  assert.equal(f.calls.checks, 2);
});

test('store updates wait for active calls and a daemon drain grant before reloading', async (t) => {
  const f = fixture(t);
  f.response.status = 'update_available';
  f.response.version = '2.3.1';
  const finish = f.controller.beginRequest();
  f.signal();
  await flush();
  f.tick();
  assert.deepEqual(f.sent, []);
  finish();
  finish();
  f.tick();
  assert.deepEqual(f.sent, [{ type: 'host.update_ready', version: '2.3.1' }]);
  assert.equal(f.calls.reloads, 0);
  f.controller.handleMessage({ type: 'host.update_apply', version: '9.0.0' });
  assert.equal(f.calls.reloads, 0);
  f.controller.handleMessage({ type: 'host.update_apply', version: '2.3.1' });
  const finishLastCall = f.controller.beginRequest();
  finishLastCall();
  f.tick();
  assert.equal(f.calls.reloads, 1);
  assert.deepEqual(f.errors, []);
});

test('unpacked extensions, disabled checks, and unexpected major updates are not forced', async (t) => {
  const f = fixture(t);
  f.deps.enabled = false;
  const disabled = createExtensionUpdateController(f.chrome, f.deps);
  disabled.handleMessage({ type: 'host.update_check', version: '2.3.0' });
  await flush();
  assert.equal(f.calls.checks, 0);
  f.deps.enabled = true;
  f.chrome.management.getSelf = async () => ({ installType: 'development' });
  f.signal();
  await flush();
  assert.equal(f.calls.checks, 0);
  f.chrome.management.getSelf = async () => ({ installType: 'normal' });
  f.response.status = 'update_available';
  f.response.version = '3.0.0';
  f.signal();
  await flush();
  assert.equal(f.calls.checks, 1);
  assert.deepEqual(f.sent, []);
  assert.equal(f.calls.reloads, 0);
});

test('disconnect and grant expiry cancel draining without replaying an update check', async (t) => {
  const f = fixture(t);
  f.response.status = 'update_available';
  f.response.version = '2.3.0';
  f.signal();
  await flush();
  f.tick();
  f.controller.disconnect();
  assert.equal(f.sent.at(-1)?.type, 'host.update_cancel');
  f.controller.handleMessage({ type: 'host.update_apply', version: '2.3.0' });
  assert.equal(f.calls.reloads, 0);
  const restarted = createExtensionUpdateController(f.chrome, f.deps);
  restarted.handleMessage({ type: 'host.update_check', version: '2.3.0' });
  await flush();
  f.tick();
  assert.equal(f.calls.checks, 1);
  f.tick(20_000);
  assert.equal(f.sent.at(-1)?.type, 'host.update_cancel');
  restarted.handleMessage({ type: 'host.update_apply', version: '2.3.0' });
  assert.equal(f.calls.reloads, 0);
});

for (const elapsedMs of [20_000, 31_000]) {
  test(`reload callback delayed by ${elapsedMs}ms requires a fresh drain grant`, async (t) => {
    const f = fixture(t);
    f.response.status = 'update_available';
    f.response.version = '2.3.0';
    f.signal();
    await flush();
    f.tick();
    f.controller.handleMessage({ type: 'host.update_apply', version: '2.3.0' });
    f.calls.now += elapsedMs;
    // Run the earlier idle callback before the overdue grant-timeout callback.
    f.tick();
    assert.equal(f.calls.reloads, 0);
    assert.equal(f.sent.at(-1)?.type, 'host.update_cancel');

    f.signal();
    await flush();
    f.tick();
    assert.equal(f.sent.at(-1)?.type, 'host.update_ready');
    assert.equal(f.calls.reloads, 0);
    f.controller.handleMessage({ type: 'host.update_apply', version: '2.3.0' });
    f.tick();
    assert.equal(f.calls.reloads, 1);
    assert.equal(f.calls.checks, 1);
    assert.deepEqual(f.errors, []);
  });
}

test('browser errors never authorize repeated checks', async (t) => {
  const f = fixture(t);
  f.chrome.runtime.requestUpdateCheck = async () => {
    f.calls.checks++;
    throw new Error('browser throttled');
  };
  f.signal();
  await flush();
  f.signal();
  await flush();
  assert.equal(f.calls.checks, 1);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.sent, []);
});

test('storage-read failure cannot bypass a persisted cooldown after restart', async (t) => {
  const f = fixture(t);
  f.signal();
  await flush();
  assert.equal(f.calls.checks, 1);
  const error = new Error('cooldown storage unreadable');
  f.chrome.storage.local.get = async () => {
    throw error;
  };
  const restarted = createExtensionUpdateController(f.chrome, f.deps);
  for (let attempt = 0; attempt < 2; attempt++) {
    restarted.handleMessage({ type: 'host.update_check', version: '2.3.0' });
    await flush();
  }
  assert.equal(f.calls.checks, 1);
  assert.equal(f.calls.reloads, 0);
  assert.deepEqual(f.errors, [error]);
  assert.deepEqual(f.sent, []);
});

test('storage failure stops the check before calling the browser API', async (t) => {
  const f = fixture(t);
  f.chrome.storage.local.set = async () => {
    throw new Error('storage unavailable');
  };
  f.signal();
  await flush();
  assert.equal(f.calls.checks, 0);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.sent, []);
});

test('busy setup actions delay reload and reload failure releases the drain', async (t) => {
  const f = fixture(t);
  f.response.status = 'update_available';
  f.response.version = '2.3.0';
  f.calls.busy = true;
  f.signal();
  await flush();
  f.tick();
  assert.equal(f.sent.length, 0);
  f.calls.busy = false;
  f.tick();
  f.controller.handleMessage({ type: 'host.update_apply', version: '2.3.0' });
  f.chrome.runtime.reload = () => {
    throw new Error('reload blocked');
  };
  f.tick();
  assert.equal(f.sent.at(-1)?.type, 'host.update_cancel');
  assert.equal(f.errors.length, 1);
  assert.equal(f.calls.reloads, 0);
});
