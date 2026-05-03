// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectBrowserName } from '../src/background-browser.js';

test('detectBrowserName returns chrome, edge, brave, or unknown from UA strings', () => {
  assert.equal(
    detectBrowserName(
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
    ),
    'chrome'
  );
  assert.equal(
    detectBrowserName(
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0'
    ),
    'edge'
  );
  assert.equal(
    detectBrowserName(
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Brave/135.0.0.0'
    ),
    'brave'
  );
  assert.equal(
    detectBrowserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15'),
    'unknown'
  );
});
