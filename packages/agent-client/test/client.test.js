// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { methodNeedsSession, parseCommaList, parseJsonObject, parsePropertyAssignments } from '../src/cli-helpers.js';
import { summarizeBridgeResponse } from '../src/subagent.js';

/** Ensure failures stay compact for parent-agent reporting. */
test('summarizeBridgeResponse condenses failures', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_fail',
    ok: false,
    result: null,
    error: {
      code: 'ACCESS_DENIED',
      message: 'Denied',
      details: { scope: 'tab' }
    },
    meta: { protocol_version: '1.0' }
  });

  assert.equal(summary.ok, false);
  assert.match(summary.summary, /ACCESS_DENIED/);
});

/** Ensure generic successes return compact evidence. */
test('summarizeBridgeResponse condenses success payloads', () => {
  const summary = summarizeBridgeResponse({
    id: 'req_ok',
    ok: true,
    result: {
      a: 1,
      b: 2
    },
    error: null,
    meta: { protocol_version: '1.0' }
  });

  assert.equal(summary.ok, true);
  assert.deepEqual(summary.evidence, ['a', 'b']);
});

/** Ensure CSS assignment parsing ignores malformed entries. */
test('parsePropertyAssignments handles css style pairs', () => {
  assert.deepEqual(
    parsePropertyAssignments(['display=flex', 'gap=8px', 'broken']),
    { display: 'flex', gap: '8px' }
  );
});

/** Ensure property lists split cleanly for style queries. */
test('parseCommaList splits and trims values', () => {
  assert.deepEqual(parseCommaList('display, color, width'), ['display', 'color', 'width']);
});

/** Ensure JSON object parsing rejects non-object shapes. */
test('parseJsonObject parses objects and rejects arrays', () => {
  assert.deepEqual(parseJsonObject('{"selector":"body"}'), { selector: 'body' });
  assert.throws(() => parseJsonObject('[1,2,3]'), /Expected JSON object input/);
});

/** Ensure session requirements are inferred correctly for generic calls. */
test('methodNeedsSession distinguishes tab-bound methods', () => {
  assert.equal(methodNeedsSession('dom.query'), true);
  assert.equal(methodNeedsSession('input.click'), true);
  assert.equal(methodNeedsSession('tabs.list'), false);
});
