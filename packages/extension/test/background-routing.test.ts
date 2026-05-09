import test from 'node:test';
import assert from 'node:assert/strict';

import { BridgeError, ERROR_CODES } from '../../protocol/src/index.js';
import {
  isRestrictedAutomationUrl,
  normalizeRequestedAccessTab,
  resolveWindowScopedTab,
  selectRequestTabCandidate,
} from '../src/background-routing.js';

function tab(fields: Record<string, unknown>): chrome.tabs.Tab {
  return fields as unknown as chrome.tabs.Tab;
}

test('background routing selects the explicit request tab when provided', () => {
  const explicitTab = tab({
    id: 7,
    windowId: 3,
    title: 'Explicit',
    url: 'https://example.com/explicit',
  });
  const activeTab = tab({
    id: 9,
    windowId: 3,
    title: 'Active',
    url: 'https://example.com/active',
  });

  const selected = selectRequestTabCandidate(7, explicitTab, activeTab);

  assert.equal(selected, explicitTab);
  assert.deepEqual(resolveWindowScopedTab(selected, 3), {
    tabId: 7,
    windowId: 3,
    title: 'Explicit',
    url: 'https://example.com/explicit',
  });
});

test('background routing rejects tabs outside the enabled window scope', () => {
  const otherWindowTab = tab({
    id: 12,
    windowId: 99,
    title: 'Other',
    url: 'https://example.com/out-of-scope',
  });

  assert.throws(
    () => resolveWindowScopedTab(otherWindowTab, 3),
    (err) => err instanceof BridgeError && err.code === ERROR_CODES.ACCESS_DENIED
  );
});

test('background routing falls back to the active tab when no explicit request id is provided', () => {
  const activeTab = tab({
    id: 9,
    windowId: 3,
    title: 'Active',
    url: 'https://example.com/active',
  });

  assert.equal(selectRequestTabCandidate(undefined, null, activeTab), activeTab);
  assert.equal(selectRequestTabCandidate(Number.NaN, null, activeTab), activeTab);
});

test('background routing treats malformed or incomplete tabs as mismatches', () => {
  assert.throws(
    () => resolveWindowScopedTab(tab({ windowId: 3 }), 3),
    (err) => err instanceof BridgeError && err.code === ERROR_CODES.TAB_MISMATCH
  );
  assert.throws(
    () => resolveWindowScopedTab(tab({ id: 1, windowId: 3, title: 'Broken' }), 3),
    (err) => err instanceof BridgeError && err.code === ERROR_CODES.TAB_MISMATCH
  );
  assert.equal(normalizeRequestedAccessTab(tab({ id: 1, windowId: 3 })), null);
});

test('background routing can allow restricted pages when scriptability is not required', () => {
  const restrictedTab = tab({
    id: 4,
    windowId: 3,
    title: 'Extensions',
    url: 'chrome://extensions',
  });

  assert.deepEqual(resolveWindowScopedTab(restrictedTab, 3, { requireScriptable: false }), {
    tabId: 4,
    windowId: 3,
    title: 'Extensions',
    url: 'chrome://extensions',
  });
});

test('background routing rejects restricted automation pages and access requests ignore them', () => {
  const restrictedUrl = 'chrome://extensions';
  const restrictedTab = tab({
    id: 4,
    windowId: 3,
    title: 'Extensions',
    url: restrictedUrl,
  });

  assert.equal(isRestrictedAutomationUrl(restrictedUrl), true);
  assert.throws(
    () => resolveWindowScopedTab(restrictedTab, 3),
    (err) => err instanceof BridgeError && err.code === ERROR_CODES.ACCESS_DENIED
  );
  assert.equal(normalizeRequestedAccessTab(restrictedTab), null);
});
