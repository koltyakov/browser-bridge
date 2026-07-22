import test from 'node:test';
import assert from 'node:assert/strict';

import { createContentScriptBridge } from '../src/background-content-script.js';

function createHarness(failMain = false) {
  const injections: Array<Record<string, unknown>> = [];
  const chromeObj = {
    tabs: {
      async sendMessage() {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      async query() {
        return [];
      },
    },
    scripting: {
      async executeScript(details: Record<string, unknown>) {
        injections.push(details);
        if (failMain && details.world === 'MAIN' && injections.length === 2) {
          throw new Error('MAIN injection failed');
        }
        return [];
      },
    },
  } as unknown as typeof chrome;
  return {
    injections,
    bridge: createContentScriptBridge(chromeObj, {
      contentScriptTimeoutMs: 1_000,
      isRestrictedAutomationUrl: () => false,
    }),
  };
}

test('general content-script injection does not install navigation listeners or MAIN hooks', async () => {
  const { bridge, injections } = createHarness();

  await bridge.ensureContentScript(8);

  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0].target, { tabId: 8 });
  assert.equal(injections[0].world, undefined);
  assert.ok(Array.isArray(injections[0].files));
  assert.equal(injections[0].func, undefined);
});

test('URL wait signal instrumentation installs and uninstalls both worlds on demand', async () => {
  const { bridge, injections } = createHarness();

  await bridge.installNavigationSignals(7, 'channel-1');
  await bridge.uninstallNavigationSignals(7, 'channel-1');

  assert.equal(injections.length, 4);
  assert.deepEqual(
    injections.map((call) => ({ target: call.target, world: call.world, args: call.args })),
    [
      { target: { tabId: 7 }, world: undefined, args: ['channel-1'] },
      { target: { tabId: 7 }, world: 'MAIN', args: ['channel-1'] },
      { target: { tabId: 7 }, world: 'MAIN', args: ['channel-1'] },
      { target: { tabId: 7 }, world: undefined, args: ['channel-1'] },
    ]
  );
});

test('failed MAIN-world installation rolls back the isolated half', async () => {
  const { bridge, injections } = createHarness(true);

  await assert.rejects(bridge.installNavigationSignals(9, 'channel-2'), /MAIN injection failed/);

  assert.equal(injections.length, 4);
  assert.deepEqual(
    injections.slice(2).map((call) => call.world),
    ['MAIN', undefined]
  );
});

test('late tabs receive independent signal channels only when their waits request them', async () => {
  const { bridge, injections } = createHarness();

  await bridge.installNavigationSignals(10, 'late-10');
  await bridge.installNavigationSignals(11, 'late-11');

  assert.deepEqual(
    injections.map((call) => ({
      tabId: (call.target as { tabId: number }).tabId,
      args: call.args,
    })),
    [
      { tabId: 10, args: ['late-10'] },
      { tabId: 10, args: ['late-10'] },
      { tabId: 11, args: ['late-11'] },
      { tabId: 11, args: ['late-11'] },
    ]
  );
});
