import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES } from '../../protocol/src/index.js';
import { createContentScriptBridge } from '../src/background-content-script.js';

function createHarness(failMain = false) {
  const injections: Array<Record<string, unknown>> = [];
  const recoveryOutcomes: Array<{ outcome: 'success' | 'failure'; group: string }> = [];
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
      recordReinjection: (outcome, group) => recoveryOutcomes.push({ outcome, group }),
    }),
    recoveryOutcomes,
  };
}

test('general content-script injection does not install navigation listeners or MAIN hooks', async () => {
  const { bridge, injections } = createHarness();

  await bridge.ensureContentScript(8);

  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0].target, { tabId: 8 });
  assert.equal(injections[0].world, undefined);
  assert.ok(Array.isArray(injections[0].files));
  assert.deepEqual(injections[0].files, [
    'packages/extension/src/content-script-helpers.js',
    'packages/extension/src/content-dom-baseline.js',
    'packages/extension/src/content-element-registry.js',
    'packages/extension/src/content-dom-query.js',
    'packages/extension/src/content-input.js',
    'packages/extension/src/content-patch.js',
    'packages/extension/src/content-script.js',
  ]);
  assert.equal(injections[0].func, undefined);
});

test('restricted content-script injection returns a typed non-retryable error', async () => {
  const recoveryOutcomes: Array<{ outcome: 'success' | 'failure'; group: string }> = [];
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
      async executeScript() {
        throw new Error('Cannot access contents of url "chrome://settings".');
      },
    },
  } as unknown as typeof chrome;
  const bridge = createContentScriptBridge(chromeObj, {
    contentScriptTimeoutMs: 1_000,
    isRestrictedAutomationUrl: () => false,
    recordReinjection: (outcome, group) => recoveryOutcomes.push({ outcome, group }),
  });

  await assert.rejects(
    () => bridge.ensureContentScript(8),
    (error: { code?: string }) => error.code === ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE
  );
  assert.deepEqual(recoveryOutcomes, [{ outcome: 'failure', group: '8' }]);
});

test('missing content-script recovery records injection separately from replay', async () => {
  const { bridge, recoveryOutcomes } = createHarness();
  await assert.rejects(
    bridge.sendTabMessage(8, { type: 'bridge.execute' }, 100),
    /Receiving end does not exist/u
  );
  assert.deepEqual(recoveryOutcomes, [{ outcome: 'success', group: '8' }]);
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
