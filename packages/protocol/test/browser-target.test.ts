import test from 'node:test';
import assert from 'node:assert/strict';
import { createFailure, validateBridgeRequest } from '../src/index.js';

test('browser routing selectors are normalized and preserved at the protocol boundary', () => {
  const request = validateBridgeRequest({
    id: 'target',
    method: 'page.get_state',
    meta: {
      target_extension: ' work-connection ',
      target_browser: ' chrome ',
      target_profile: ' Work ',
    },
  });
  assert.equal(request.meta.target_extension, 'work-connection');
  assert.equal(request.meta.target_browser, 'chrome');
  assert.equal(request.meta.target_profile, 'Work');
});

test('invalid explicit routing selectors never degrade to implicit routing', () => {
  for (const field of ['target_extension', 'target_browser', 'target_profile']) {
    for (const value of [null, 42, {}, '', ' ', 'a'.repeat(257), 'work\n']) {
      assert.throws(
        () =>
          validateBridgeRequest({
            id: 'invalid',
            method: 'page.get_state',
            meta: { [field]: value },
          }),
        /must be a non-empty string/
      );
    }
  }
});

test('routing recovery tells agents to select a profile instead of enabling or retrying the wrong one', () => {
  for (const [code, reason] of [
    ['TAB_MISMATCH', 'ambiguous_browser_target'],
    ['EXTENSION_DISCONNECTED', 'browser_target_disconnected'],
    ['ACCESS_DENIED', 'no_enabled_browser_profiles'],
  ] as const) {
    const response = createFailure('routing', code, 'Routing unavailable', { reason });
    assert.equal(response.error.recovery?.retry, false);
    assert.equal(response.error.recovery?.alternativeMethod, 'health.ping');
    assert.match(response.error.recovery?.hint ?? '', /extensionId/);
    assert.doesNotMatch(
      response.error.recovery?.hint ?? '',
      /Tab was closed|Access is off for this window/
    );
  }
  assert.equal(
    createFailure('unavailable', 'EXTENSION_DISCONNECTED', 'No extension').error.recovery?.retry,
    true
  );
});
