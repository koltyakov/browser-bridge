import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSensitiveIncidentalKey,
  sanitizeIncidentalPath,
  sanitizeIncidentalText,
  sanitizeIncidentalUrl,
  sanitizeIncidentalValue,
} from '../src/incidental-sanitizer.js';

test('sanitizeIncidentalUrl removes credentials, fragments, and query values', () => {
  assert.equal(
    sanitizeIncidentalUrl('https://user:secret@example.test/path?token=abc&flag=yes#private'),
    'https://example.test/path?token=%5Bredacted%5D&flag=%5Bredacted%5D'
  );
  assert.equal(
    sanitizeIncidentalUrl('data:text/plain;base64,c2VjcmV0'),
    'data:text/plain;[redacted]'
  );
  assert.equal(
    sanitizeIncidentalUrl('blob:https://example.test/1234-secret'),
    'blob:https://example.test/[redacted]'
  );
  assert.equal(sanitizeIncidentalUrl('broken?secret=yes#fragment'), 'broken');
  assert.equal(sanitizeIncidentalUrl('https://user:pass@[bad]?secret=yes'), 'https://[bad]');
});

test('sanitizeIncidentalValue recursively redacts sensitive keys without substring false positives', () => {
  const cyclic: Record<string, unknown> = {
    authorization: 'Bearer secret',
    nested: [{ password: 'secret', tokenCount: 7, api_key: 'secret' }],
    url: 'https://user:pass@example.test/a?q=secret#fragment',
  };
  cyclic.self = cyclic;

  assert.deepEqual(sanitizeIncidentalValue(cyclic), {
    authorization: '[redacted]',
    nested: [{ password: '[redacted]', tokenCount: 7, api_key: '[redacted]' }],
    url: 'https://example.test/a?q=%5Bredacted%5D',
    self: '[circular]',
  });
  assert.equal(isSensitiveIncidentalKey('refresh-token'), true);
  assert.equal(isSensitiveIncidentalKey('tokenCount'), false);
  assert.equal(isSensitiveIncidentalKey('tokenizer'), false);
});

test('incidental text and path sanitization covers Unix, Windows, UNC, and credential headers', () => {
  assert.equal(sanitizeIncidentalPath('/Users/alice/private/key.txt'), '[redacted-path]/key.txt');
  assert.equal(
    sanitizeIncidentalPath('C:\\Users\\Alice\\secret.json'),
    '[redacted-path]/secret.json'
  );
  assert.equal(
    sanitizeIncidentalText(
      'Authorization: Bearer abc at /Users/alice/private/key.txt and C:\\Users\\Alice\\secret.json'
    ),
    'Authorization: [redacted]'
  );
  assert.deepEqual(
    sanitizeIncidentalValue({
      path: '/var/folders/private/daemon.log',
      unc: '\\\\server\\share\\secret.txt',
      message: 'Cookie: sid=secret',
    }),
    {
      path: '[redacted-path]/daemon.log',
      unc: '[redacted-path]/secret.txt',
      message: 'Cookie: [redacted]',
    }
  );
  assert.equal(
    sanitizeIncidentalText(
      'chrome://settings/?token=secret and /root/private/secret.txt and /usr/local/private/config.json'
    ),
    'chrome://settings/?token=%5Bredacted%5D and [redacted-path]/secret.txt and [redacted-path]/config.json'
  );
});

test('sanitizeIncidentalValue bounds traversal and handles browser URLs and errors', () => {
  assert.deepEqual(
    sanitizeIncidentalValue(
      {
        url: 'chrome://settings/?secret=value#fragment',
        error: new Error('failed at /home/alice/project/config.json'),
        deep: { one: { two: { three: true } } },
      },
      { maxDepth: 2 }
    ),
    {
      url: 'chrome://settings/?secret=%5Bredacted%5D',
      error: {
        name: 'Error',
        message: 'failed at [redacted-path]/config.json',
      },
      deep: { one: '[truncated]' },
    }
  );
});
