import test from 'node:test';
import assert from 'node:assert/strict';

import { createRequest, createSuccess } from '../../protocol/src/index.js';
import { printCallResponse } from '../src/cli-output.js';

test('printCallResponse preserves exact sensitive values through JSON encoding', () => {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    const request = createRequest({
      id: 'cli-sensitive',
      method: 'sensitive.read',
      params: { source: 'local_storage', key: 'private-token' },
    });
    const value = '\u001b[31mline 1\n\u2603 {"token":"value"}';
    printCallResponse(
      createSuccess(request.id, { source: 'local_storage', value, exact: true }),
      request.method
    );

    assert.equal(JSON.parse(output).value, value);
    assert.equal(output.includes('\u001b'), false);
    assert.match(output, /\\u001b/);
  } finally {
    process.stdout.write = originalWrite;
  }
});
