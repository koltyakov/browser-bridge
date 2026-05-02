// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES } from '../../protocol/src/index.js';
import { handleNavigationRequest } from '../src/background-navigation.js';
import { makeRequest } from '../../../tests/_helpers/protocolFactories.js';

/**
 * @typedef {{
 *   resolveRequestTarget: (request: { id: string, method: string, params: Record<string, unknown> }, options?: { requireScriptable?: boolean }) => Promise<{ tabId: number, windowId: number, title: string, url: string }>,
 *   updateTab: (tabId: number, properties: { url: string }) => Promise<unknown>,
 *   reloadTab: (tabId: number) => Promise<void>,
 *   goBack: (tabId: number) => Promise<void>,
 *   goForward: (tabId: number) => Promise<void>,
 *   waitForTabComplete: (tabId: number, timeoutMs: number) => Promise<chrome.tabs.Tab>,
 *   getTab: (tabId: number) => Promise<chrome.tabs.Tab>,
 *   emitUiState: () => Promise<void>,
 * }} NavigationDependencies
 */

/**
 * @param {Partial<NavigationDependencies>} [overrides]
 * @returns {NavigationDependencies & {
 *   calls: {
 *     update: Array<{ tabId: number, properties: { url: string } }>,
 *     reload: number[],
 *     goBack: number[],
 *     goForward: number[],
 *     wait: Array<{ tabId: number, timeoutMs: number }>,
 *     get: number[],
 *     emitUiState: number,
 *   }
 * }}
 */
function createDependencies(overrides = {}) {
  /** @type {{
   *   update: Array<{ tabId: number, properties: { url: string } }>,
   *   reload: number[],
   *   goBack: number[],
   *   goForward: number[],
   *   wait: Array<{ tabId: number, timeoutMs: number }>,
   *   get: number[],
   *   emitUiState: number,
   * }} */
  const calls = {
    update: [],
    reload: [],
    goBack: [],
    goForward: [],
    wait: [],
    get: [],
    emitUiState: 0,
  };
  const completedTab = /** @type {chrome.tabs.Tab} */ ({
    id: 17,
    windowId: 4,
    title: 'Example',
    url: 'https://example.com/next',
    status: 'complete',
  });

  return {
    calls,
    async resolveRequestTarget() {
      return {
        tabId: 17,
        windowId: 4,
        title: 'Example',
        url: 'https://example.com/current',
      };
    },
    async updateTab(tabId, properties) {
      calls.update.push({ tabId, properties });
      return completedTab;
    },
    async reloadTab(tabId) {
      calls.reload.push(tabId);
    },
    async goBack(tabId) {
      calls.goBack.push(tabId);
    },
    async goForward(tabId) {
      calls.goForward.push(tabId);
    },
    async waitForTabComplete(tabId, timeoutMs) {
      calls.wait.push({ tabId, timeoutMs });
      return completedTab;
    },
    async getTab(tabId) {
      calls.get.push(tabId);
      return completedTab;
    },
    async emitUiState() {
      calls.emitUiState += 1;
    },
    ...overrides,
  };
}

test('handleNavigationRequest enforces scriptable target resolution before navigation', async () => {
  const dependencies = createDependencies({
    async resolveRequestTarget() {
      throw new Error(ERROR_CODES.ACCESS_DENIED);
    },
  });

  await assert.rejects(
    () =>
      handleNavigationRequest(
        makeRequest('navigation.reload', {
          id: 'req-1',
          params: {},
        }),
        dependencies
      ),
    new Error(ERROR_CODES.ACCESS_DENIED)
  );

  assert.deepEqual(dependencies.calls.reload, []);
  assert.equal(dependencies.calls.emitUiState, 0);
});

test('handleNavigationRequest rejects unsupported navigation URL schemes', async () => {
  const dependencies = createDependencies();

  await assert.rejects(
    async () => {
      const request = makeRequest('navigation.navigate', {
        id: 'req-2',
        params: { url: 'chrome://settings' },
      });
      await handleNavigationRequest(request, dependencies);
    },
    (error) => {
      const bridgeError = /** @type {Error & { code?: string, message?: string }} */ (error);
      assert.equal(bridgeError.code, ERROR_CODES.INVALID_REQUEST);
      assert.match(String(bridgeError.message), /unsupported protocol/i);
      return true;
    }
  );

  assert.deepEqual(dependencies.calls.update, []);
  assert.equal(dependencies.calls.emitUiState, 0);
});

test('handleNavigationRequest navigates and waits for completion by default', async () => {
  const dependencies = createDependencies();
  const response = await handleNavigationRequest(
    makeRequest('navigation.navigate', {
      id: 'req-3',
      params: { url: 'https://example.com/next', timeoutMs: 999 },
    }),
    dependencies
  );

  assert.deepEqual(dependencies.calls.update, [
    { tabId: 17, properties: { url: 'https://example.com/next' } },
  ]);
  assert.deepEqual(dependencies.calls.wait, [{ tabId: 17, timeoutMs: 999 }]);
  assert.deepEqual(dependencies.calls.get, []);
  assert.equal(dependencies.calls.emitUiState, 1);
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    method: 'navigation.navigate',
    tabId: 17,
    windowId: 4,
    title: 'Example',
    url: 'https://example.com/next',
    status: 'complete',
  });
});

test('handleNavigationRequest can skip waiting and read the tab directly', async () => {
  const dependencies = createDependencies();
  const response = await handleNavigationRequest(
    makeRequest('navigation.go_forward', {
      id: 'req-4',
      params: { waitForLoad: false },
    }),
    dependencies
  );

  assert.deepEqual(dependencies.calls.goForward, [17]);
  assert.deepEqual(dependencies.calls.wait, []);
  assert.deepEqual(dependencies.calls.get, [17]);
  assert.equal(dependencies.calls.emitUiState, 1);
  assert.equal(response.ok, true);
});
