// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeEvent, createChromeFake } from '../../../tests/_helpers/chromeFake.js';
import { loadBackground } from '../../../tests/_helpers/loadBackground.js';

/**
 * @returns {any}
 */
function createNativePort() {
  return {
    postMessage() {},
    disconnect() {},
    onMessage: createChromeEvent(),
    onDisconnect: createChromeEvent(),
    name: 'native',
  };
}

test('loadBackground imports the service worker against an injected chrome fake', async () => {
  const nativePort = createNativePort();
  const chrome = createChromeFake({
    runtime: {
      /** @param {string} appName */
      connectNative(appName) {
        assert.equal(appName, 'com.browserbridge.browser_bridge');
        return nativePort;
      },
    },
  });

  const loaded = await loadBackground({
    chrome,
    query: `test-load-background-${Date.now()}`,
  });

  assert.equal(loaded.chrome, chrome);
  assert.equal(typeof loaded.module, 'object');
  assert.equal(chrome.runtime.onInstalled.listeners.length, 1);
  assert.equal(chrome.runtime.onConnect.listeners.length, 1);
  assert.equal(chrome.runtime.onMessage.listeners.length, 1);
  assert.equal(chrome.tabs.onActivated.listeners.length, 1);
  assert.equal(chrome.tabs.onUpdated.listeners.length, 1);
  assert.equal(chrome.tabs.onRemoved.listeners.length, 1);
  assert.equal(chrome.windows.onFocusChanged.listeners.length, 1);
  assert.equal(chrome.windows.onRemoved.listeners.length, 1);
  assert.equal(chrome.alarms.onAlarm.listeners.length, 1);
  assert.equal(nativePort.onMessage.listeners.length, 1);
  assert.equal(nativePort.onDisconnect.listeners.length, 1);
  assert.equal('chrome' in globalThis, false);
});

test('loadBackground exposes direct test seams for background helper functions', async () => {
  const loaded = await loadBackground({
    query: `test-background-exports-${Date.now()}`,
  });

  assert.equal(loaded.module.getUiSurfaceFromPortName('ui-sidepanel'), 'sidepanel');
  assert.equal(loaded.module.getUiSurfaceFromPortName('unknown-surface'), null);
  assert.equal(loaded.module.normalizeActionLogSource('mcp'), 'mcp');
  assert.equal(loaded.module.normalizeActionLogSource('agent'), '');
  assert.deepEqual(
    loaded.module.normalizeSetupInstallAction({
      action: 'uninstall',
      kind: 'skill',
      target: ' Copilot ',
    }),
    {
      action: 'uninstall',
      kind: 'skill',
      target: 'copilot',
    }
  );
  assert.deepEqual(
    loaded.module.normalizeActionLogEntry({
      id: 'entry-1',
      at: '17',
      method: 'tabs.list',
      source: 'cli',
      tabId: 4,
      url: 'https://example.com/',
      ok: true,
      summary: 'Listed tabs',
      costClass: 'heavy',
      summaryCostClass: 'moderate',
      debuggerBacked: true,
      overBudget: true,
      hasScreenshot: true,
      nodeCount: 3,
      continuationHint: 'continue',
    }),
    {
      id: 'entry-1',
      at: 17,
      method: 'tabs.list',
      source: 'cli',
      tabId: 4,
      url: 'https://example.com/',
      ok: true,
      summary: 'Listed tabs',
      responseBytes: 0,
      approxTokens: 0,
      imageApproxTokens: 0,
      costClass: 'heavy',
      imageBytes: 0,
      summaryBytes: 0,
      summaryTokens: 0,
      summaryCostClass: 'moderate',
      debuggerBacked: true,
      overBudget: true,
      hasScreenshot: true,
      nodeCount: 3,
      continuationHint: 'continue',
    }
  );
});
