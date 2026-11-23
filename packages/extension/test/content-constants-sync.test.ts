import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MAX_HTML_LENGTH, MAX_PRUNED_HTML_LENGTH } from '../../../protocol/src/defaults.ts';

// Content scripts are classic scripts and cannot import protocol defaults, so
// they repeat a few limits. Fail when a copy drifts from the source of truth.
test('content-script HTML limits match protocol defaults', async () => {
  const source = await readFile(new URL('../src/content-dom-query.ts', import.meta.url), 'utf8');
  const read = (name: string): number => {
    const match = new RegExp(`const ${name} = ([0-9_]+);`).exec(source);
    assert.ok(match, `${name} is declared in content-dom-query.ts`);
    return Number(match[1].replaceAll('_', ''));
  };
  assert.equal(read('MAX_HTML_LENGTH'), MAX_HTML_LENGTH);
  assert.equal(read('MAX_PRUNED_HTML_LENGTH'), MAX_PRUNED_HTML_LENGTH);
});
