import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDevelopmentReloadController,
  DEVELOPMENT_BUILD_STAMP,
  DEVELOPMENT_RELOAD_ALARM,
} from '../src/background-development.js';
import { createChromeFake, type FakeChromeEvent } from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import { loadExtensionModule } from '../../../tests/_helpers/extensionBuild.ts';

const loadedDigest = 'a'.repeat(64);
const changedDigest = 'b'.repeat(64);

function stamp(sourceDigest: string = changedDigest): Response {
  return new Response(JSON.stringify({ formatVersion: 1, complete: true, sourceDigest }));
}

function setup(
  options: {
    enabled?: boolean;
    sourceDigest?: string | null;
    getSelf?: () => Promise<{ installType: string }>;
    fetch?: typeof fetch;
  } = {}
) {
  let reloads = 0;
  let fetches = 0;
  const controller = createDevelopmentReloadController(
    {
      runtime: {
        getURL: (path) => `chrome-extension://test/${path}`,
        reload: () => {
          reloads += 1;
        },
      },
      ...(options.getSelf ? { management: { getSelf: options.getSelf } } : {}),
    },
    {
      enabled: options.enabled ?? true,
      sourceDigest: options.sourceDigest === undefined ? loadedDigest : options.sourceDigest,
      fetch: async (url, init) => {
        fetches += 1;
        assert.equal(url, `chrome-extension://test/${DEVELOPMENT_BUILD_STAMP}`);
        assert.equal(init?.cache, 'no-store');
        return options.fetch ? options.fetch(url, init) : stamp();
      },
    }
  );
  return { ...controller, reloads: () => reloads, fetches: () => fetches };
}

test('changed complete development stamp reloads once across concurrent and later checks', async () => {
  const controller = setup({ getSelf: async () => ({ installType: 'development' }) });
  await Promise.all([controller.checkForUpdate(), controller.checkForUpdate()]);
  await controller.checkForUpdate();
  assert.equal(controller.fetches(), 1);
  assert.equal(controller.reloads(), 1);
});

test('same digest does not reload, but a later build does', async () => {
  let currentDigest = loadedDigest;
  const controller = setup({ fetch: async () => stamp(currentDigest) });
  await controller.checkForUpdate();
  assert.equal(controller.reloads(), 0);
  currentDigest = changedDigest;
  await controller.checkForUpdate();
  assert.equal(controller.reloads(), 1);

  const restarted = setup({ sourceDigest: changedDigest });
  await restarted.checkForUpdate();
  assert.equal(restarted.reloads(), 0);
});

test('missing, malformed, incomplete and failed stamp reads wait for a complete build', async () => {
  const responses: Array<() => Promise<Response>> = [
    async () => {
      throw new Error('Staging directory removed');
    },
    async () => new Response('', { status: 404 }),
    async () => new Response('{'),
    ...[
      null,
      [],
      {},
      { formatVersion: 2, complete: true, sourceDigest: changedDigest },
      { formatVersion: 1, complete: false, sourceDigest: changedDigest },
      { formatVersion: 1, complete: true, sourceDigest: 'partial' },
      { formatVersion: 1, complete: true, sourceDigest: 123 },
    ].map((value) => async () => new Response(JSON.stringify(value))),
  ];
  for (const response of responses) {
    let ready = false;
    const controller = setup({ fetch: () => (ready ? Promise.resolve(stamp()) : response()) });
    await controller.checkForUpdate();
    assert.equal(controller.reloads(), 0);
    ready = true;
    await controller.checkForUpdate();
    assert.equal(controller.reloads(), 1);
  }
});

test('production builds, non-development installs and ungenerated checkouts do not fetch or reload', async () => {
  for (const options of [
    { enabled: false },
    { sourceDigest: null },
    { getSelf: async () => ({ installType: 'normal' }) },
    { getSelf: async () => ({ installType: 'admin' }) },
    {
      getSelf: async () => {
        throw new Error('Management unavailable');
      },
    },
  ]) {
    const controller = setup(options);
    await controller.checkForUpdate();
    assert.equal(controller.fetches(), 0);
    assert.equal(controller.reloads(), 0);
  }
});

test('service worker checks at native startup and on its independent development alarm', async (t) => {
  const buildInfo =
    await loadExtensionModule<typeof import('../src/build-info.js')>('src/build-info.js');
  assert.equal(buildInfo.DEVELOPMENT_AUTO_RELOAD, true);
  assert.ok(buildInfo.SOURCE_DIGEST);
  let currentDigest = buildInfo.SOURCE_DIGEST;
  let fetches = 0;
  let reloads = 0;
  const alarms: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, `chrome-extension://test-extension-id/${DEVELOPMENT_BUILD_STAMP}`);
    assert.equal(init.cache, 'no-store');
    fetches += 1;
    return stamp(currentDigest);
  });
  const chrome = createChromeFake({
    runtime: {
      reload: () => {
        reloads += 1;
      },
    },
    alarms: {
      create: async (name: string) => {
        alarms.push(name);
      },
    },
  });
  await loadBackground({ chrome });
  // Allow the response body promise to settle before firing the next event.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  assert.equal(reloads, 0);
  assert.ok(alarms.includes(DEVELOPMENT_RELOAD_ALARM));
  currentDigest = changedDigest;
  const onAlarm = (chrome.alarms as { onAlarm: FakeChromeEvent }).onAlarm;
  onAlarm.dispatch({ name: DEVELOPMENT_RELOAD_ALARM });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fetches, 2);
  assert.equal(reloads, 1);
});
