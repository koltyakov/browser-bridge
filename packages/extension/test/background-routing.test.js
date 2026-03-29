// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES } from '../../protocol/src/index.js';
import {
  isRestrictedAutomationUrl,
  normalizeRequestedAccessTab,
  resolveWindowScopedTab,
  selectRequestTabCandidate
} from '../src/background-routing.js';

test('background routing selects the explicit request tab when provided', () => {
  const explicitTab = /** @type {chrome.tabs.Tab} */ ({
    id: 7,
    windowId: 3,
    title: 'Explicit',
    url: 'https://example.com/explicit'
  });
  const activeTab = /** @type {chrome.tabs.Tab} */ ({
    id: 9,
    windowId: 3,
    title: 'Active',
    url: 'https://example.com/active'
  });

  const selected = selectRequestTabCandidate(7, explicitTab, activeTab);

  assert.equal(selected, explicitTab);
  assert.deepEqual(resolveWindowScopedTab(selected, 3), {
    tabId: 7,
    windowId: 3,
    title: 'Explicit',
    url: 'https://example.com/explicit'
  });
});

test('background routing rejects tabs outside the enabled window scope', () => {
  const otherWindowTab = /** @type {chrome.tabs.Tab} */ ({
    id: 12,
    windowId: 99,
    title: 'Other',
    url: 'https://example.com/out-of-scope'
  });

  assert.throws(
    () => resolveWindowScopedTab(otherWindowTab, 3),
    new Error(ERROR_CODES.ACCESS_DENIED)
  );
});

test('background routing rejects restricted automation pages and access requests ignore them', () => {
  const restrictedUrl = 'chrome://extensions';
  const restrictedTab = /** @type {chrome.tabs.Tab} */ ({
    id: 4,
    windowId: 3,
    title: 'Extensions',
    url: restrictedUrl
  });

  assert.equal(isRestrictedAutomationUrl(restrictedUrl), true);
  assert.throws(
    () => resolveWindowScopedTab(restrictedTab, 3),
    new Error(ERROR_CODES.ACCESS_DENIED)
  );
  assert.equal(normalizeRequestedAccessTab(restrictedTab), null);
});
