import test from 'node:test';
import assert from 'node:assert/strict';

import {
  type ChromeFake,
  type FakeChromeEvent,
  createChromeEvent,
  createChromeFake,
} from '../../../tests/_helpers/chromeFake.ts';
import { loadBackground } from '../../../tests/_helpers/loadBackground.ts';
import { createRequest } from '../../protocol/src/index.js';

function createNativePort(): {
  postMessage: () => void;
  disconnect: () => void;
  onMessage: FakeChromeEvent;
  onDisconnect: FakeChromeEvent;
  name: string;
} {
  return {
    postMessage() {},
    disconnect() {},
    onMessage: createChromeEvent(),
    onDisconnect: createChromeEvent(),
    name: 'native',
  };
}

type LoadBackgroundChrome = ChromeFake & {
  runtime: ChromeFake['runtime'] & {
    onInstalled: FakeChromeEvent;
    onConnect: FakeChromeEvent;
    onMessage: FakeChromeEvent;
  };
  tabs: ChromeFake['tabs'] & {
    onActivated: FakeChromeEvent;
    onUpdated: FakeChromeEvent;
    onRemoved: FakeChromeEvent;
  };
  windows: {
    onFocusChanged: FakeChromeEvent;
    onRemoved: FakeChromeEvent;
  };
  alarms: {
    onAlarm: FakeChromeEvent;
  };
};

type BackgroundTestModule = {
  isNumber: (value: unknown) => boolean;
  getStateForTest: () => unknown;
  getUiSurfaceFromPortName: (name: string) => string | null;
  normalizeActionLogSource: (source: string) => string;
  normalizeSetupInstallAction: (entry: Record<string, unknown>) => Record<string, unknown>;
  normalizeActionLogEntry: (entry: Record<string, unknown>) => Record<string, unknown>;
};

test('loadBackground imports the service worker against an injected chrome fake', async () => {
  const nativePort = createNativePort();
  const chrome = createChromeFake({
    runtime: {
      connectNative(appName: string) {
        assert.equal(appName, 'com.browserbridge.browser_bridge');
        return nativePort;
      },
    },
  }) as LoadBackgroundChrome;

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
  const module = loaded.module as BackgroundTestModule;

  assert.equal(module.isNumber(4), true);
  assert.equal(module.getStateForTest(), module.getStateForTest());
  assert.equal(module.getUiSurfaceFromPortName('ui-sidepanel'), 'sidepanel');
  assert.equal(module.getUiSurfaceFromPortName('unknown-surface'), null);
  assert.equal(module.normalizeActionLogSource('mcp'), 'mcp');
  assert.equal(module.normalizeActionLogSource('agent'), '');
  assert.deepEqual(
    module.normalizeSetupInstallAction({
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
    module.normalizeActionLogEntry({
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

  const response = await loaded.dispatch(
    createRequest({
      id: 'health-ping',
      method: 'health.ping',
    })
  );
  assert.equal(response.id, 'health-ping');
  assert.equal(response.ok, true);
  assert.equal(response.meta?.method, 'health.ping');
});
