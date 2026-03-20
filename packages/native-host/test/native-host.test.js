// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { bindBridgeSocketLifecycle } from '../src/native-host.js';

/** Ensure daemon socket teardown terminates the native host promptly. */
test('bindBridgeSocketLifecycle terminates once on socket close', () => {
  const socket = new EventEmitter();
  let terminated = 0;

  bindBridgeSocketLifecycle(
    /** @type {import('node:net').Socket} */ (/** @type {unknown} */ (socket)),
    () => {
      terminated += 1;
    }
  );

  socket.emit('end');
  socket.emit('close');
  socket.emit('error', new Error('daemon stopped'));

  assert.equal(terminated, 1);
});
