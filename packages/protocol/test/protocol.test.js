// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CAPABILITIES,
  ERROR_CODES,
  applyBudget,
  createFailure,
  createRequest,
  createRuntimeContext,
  createSuccess,
  normalizeAccessRequest,
  normalizeInputAction,
  normalizePatchOperation,
  truncateText
} from '../src/index.js';

/** Ensure budgeting normalizes user-provided limits safely. */
test('applyBudget clamps and normalizes fields', () => {
  const budget = applyBudget({
    maxNodes: 999,
    maxDepth: -1,
    textBudget: 4,
    attributeAllowlist: ['id', 'id', '', 'data-test']
  });

  assert.equal(budget.maxNodes, 250);
  assert.equal(budget.maxDepth, 1);
  assert.equal(budget.textBudget, 32);
  assert.deepEqual(budget.attributeAllowlist, ['id', 'data-test']);
});

/** Ensure protocol metadata is always attached to outgoing requests. */
test('createRequest adds protocol metadata', () => {
  const request = createRequest({
    id: 'req_1',
    method: 'health.ping'
  });

  assert.equal(request.meta.protocol_version, '1.0');
});

/** Ensure access requests inherit the default capability bundle. */
test('normalizeAccessRequest falls back to default capabilities', () => {
  const access = normalizeAccessRequest({
    tabId: 5,
    origin: 'https://example.com'
  });

  assert.deepEqual(access.capabilities, DEFAULT_CAPABILITIES);
  assert.equal(access.capabilities.includes('automation.input'), true);
  assert.equal(access.tabId, 5);
  assert.ok(access.ttlMs >= 10 * 365 * 24 * 60 * 60 * 1000);
});

/** Ensure tab resolution can be deferred to the extension. */
test('normalizeAccessRequest allows extension-side tab resolution', () => {
  const access = normalizeAccessRequest({
    origin: ''
  });

  assert.equal(access.tabId, null);
  assert.equal(access.origin, '');
});

/** Ensure success and failure responses keep the shared envelope shape. */
test('createSuccess and createFailure shape bridge responses', () => {
  const success = createSuccess('req_2', { ok: true }, { revision: 'rev_1' });
  const failure = createFailure('req_3', ERROR_CODES.ACCESS_DENIED, 'Denied');

  assert.equal(success.ok, true);
  assert.equal(success.meta.revision, 'rev_1');
  assert.equal(failure.error.code, ERROR_CODES.ACCESS_DENIED);
});

/** Ensure truncation metadata stays consistent. */
test('truncateText reports truncation metadata', () => {
  const result = truncateText('abcdef', 4);
  assert.equal(result.truncated, true);
  assert.equal(result.omitted, 2);
});

/** Ensure runtime guidance remains compact and opinionated. */
test('runtime context stays compact and opinionated', () => {
  const context = createRuntimeContext();
  assert.equal(context.protocolVersion, '1.0');
  assert.ok(context.guidance.length >= 3);
});

/** Ensure DOM patch metadata is preserved by normalization. */
test('normalizePatchOperation preserves DOM patch metadata', () => {
  const patch = normalizePatchOperation({
    operation: 'set_attribute',
    name: 'aria-hidden',
    value: 'true'
  });

  assert.equal(patch.name, 'aria-hidden');
  assert.equal(patch.value, 'true');
});

/** Ensure input actions normalize button and modifier defaults safely. */
test('normalizeInputAction preserves interactive intent', () => {
  const input = normalizeInputAction({
    target: { selector: 'button.primary' },
    button: 'right',
    clickCount: 9,
    key: 'Enter',
    modifiers: ['Shift', '']
  });

  assert.equal(input.target.selector, 'button.primary');
  assert.equal(input.button, 'right');
  assert.equal(input.clickCount, 2);
  assert.equal(input.key, 'Enter');
  assert.deepEqual(input.modifiers, ['Shift']);
});
