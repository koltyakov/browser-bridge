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

test('detectBrowserName returns other Chromium-family browser names from UA strings', () => {
  assert.equal(detectBrowserName('Mozilla/5.0 Chrome/135.0.0.0 OPR/120.0.0.0'), 'opera');
  assert.equal(detectBrowserName('Mozilla/5.0 Chrome/135.0.0.0 Opera'), 'opera');
  assert.equal(detectBrowserName('Mozilla/5.0 Chrome/135.0.0.0 Arc/1.0.0'), 'arc');
  assert.equal(detectBrowserName('Mozilla/5.0 Chrome/135.0.0.0 Vivaldi/7.0'), 'vivaldi');
  assert.equal(detectBrowserName('Mozilla/5.0 Chromium/135.0.0.0'), 'chrome');
});

test('detectBrowserName falls back to global navigator userAgent when omitted', () => {
  const priorNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 Chrome/135.0.0.0 Arc/1.0.0' },
  });

  try {
    assert.equal(detectBrowserName(), 'arc');
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: priorNavigator,
    });
  }
});
