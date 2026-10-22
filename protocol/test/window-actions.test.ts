import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowActionCommand, parseWindowActionRequest } from '../src/window-actions.js';

const command = { requestId: 'request', action: 'focus', windowId: 7, enabledAt: 123 };

test('local window action messages accept only bounded focus and disable targets', () => {
  assert.deepEqual(parseWindowActionCommand(command), command);
  assert.deepEqual(parseWindowActionCommand({ ...command, action: 'disable', extra: 'ignored' }), {
    ...command,
    action: 'disable',
  });
  assert.deepEqual(parseWindowActionRequest({ ...command, extensionId: 'edge' }), {
    ...command,
    extensionId: 'edge',
  });
  for (const value of [
    null,
    false,
    'invalid',
    {},
    { ...command, requestId: '' },
    { ...command, requestId: 'x'.repeat(81) },
    { ...command, action: 'enable' },
    { ...command, windowId: 0 },
    { ...command, windowId: 1.5 },
    { ...command, windowId: '7' },
    { ...command, enabledAt: -1 },
    { ...command, enabledAt: Infinity },
    { ...command, enabledAt: '123' },
  ]) {
    assert.equal(parseWindowActionCommand(value), null);
  }
  for (const value of [
    {},
    command,
    { ...command, extensionId: '' },
    { ...command, extensionId: 42 },
    { ...command, extensionId: 'x'.repeat(81) },
  ]) {
    assert.equal(parseWindowActionRequest(value), null);
  }
});
