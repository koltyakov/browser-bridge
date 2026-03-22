// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferCapability,
  normalizeCropRect,
  normalizeRuntimeErrorMessage,
  safeOrigin,
  shouldLogAction,
  simplifyAXNode,
  summarizeActionResult,
  summarizeTabResult
} from '../src/background-helpers.js';

test('background helpers infer capabilities and normalize runtime errors', () => {
  assert.equal(inferCapability('page.evaluate'), 'page.evaluate');
  assert.equal(inferCapability('tabs.create'), 'tabs.manage');
  assert.equal(inferCapability('tabs.list'), null);
  assert.equal(normalizeRuntimeErrorMessage('No tab with id: 7.'), 'TAB_MISMATCH');
  assert.equal(normalizeRuntimeErrorMessage('boom'), 'boom');
});

test('background helpers summarize responses and tabs', () => {
  assert.deepEqual(summarizeTabResult(/** @type {any} */ ({
    id: 7,
    windowId: 3,
    url: 'https://example.com',
    title: 'Example',
    status: 'complete'
  }), 'navigation.navigate'), {
    method: 'navigation.navigate',
    tabId: 7,
    windowId: 3,
    url: 'https://example.com',
    title: 'Example',
    status: 'complete'
  });

  assert.equal(summarizeActionResult({
    id: 'req_1',
    ok: true,
    result: { patchId: 'patch_1' },
    error: null,
    meta: { protocol_version: '1.0' }
  }), 'Patch patch_1 applied.');
  assert.equal(summarizeActionResult({
    id: 'req_2',
    ok: false,
    result: null,
    error: { code: 'ACCESS_DENIED', message: 'Denied', details: null },
    meta: { protocol_version: '1.0' }
  }), 'Denied');
});

test('background helpers normalize crop rects and accessibility nodes', () => {
  assert.deepEqual(normalizeCropRect({ x: 10.4, y: -5, width: 0, height: 0, scale: 2 }), {
    x: 21,
    y: 0,
    width: 2,
    height: 2
  });

  assert.deepEqual(simplifyAXNode({
    nodeId: 5,
    role: { value: 'button' },
    name: { value: 'Save' },
    focused: { value: true },
    required: { value: false },
    checked: { value: 'mixed' },
    disabled: { value: false },
    focusable: { value: true },
    childIds: [1, 2]
  }), {
    nodeId: '5',
    role: 'button',
    name: 'Save',
    description: '',
    value: '',
    focused: true,
    required: false,
    checked: 'mixed',
    disabled: false,
    interactive: true,
    childIds: ['1', '2']
  });
});

test('background helpers expose log and origin helpers', () => {
  assert.equal(shouldLogAction('dom.query'), true);
  assert.equal(shouldLogAction('health.ping'), false);
  assert.equal(safeOrigin('https://example.com/path?q=1'), 'https://example.com');
  assert.equal(safeOrigin('not-a-url'), '');
});
