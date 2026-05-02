// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { SUPPORTED_VERSIONS } from '../../protocol/src/index.js';
import {
  compareProtocolVersions,
  getVersionNegotiationPayload,
} from '../src/background-versioning.js';

test('compareProtocolVersions correctly orders semver-ish strings', () => {
  assert.equal(compareProtocolVersions('1.0', '1.0'), 0);
  assert.equal(compareProtocolVersions('1.2', '1.10'), -1);
  assert.equal(compareProtocolVersions('2', '1.9'), 1);
  assert.equal(compareProtocolVersions('1.0.1', '1'), 1);
  assert.equal(compareProtocolVersions('1.0', '1.0.0'), 0);
  assert.equal(compareProtocolVersions('1.beta', '1.0'), 0);
});

test('getVersionNegotiationPayload returns supported list without warning for missing or supported versions', () => {
  assert.deepEqual(getVersionNegotiationPayload(undefined), {
    supported_versions: SUPPORTED_VERSIONS,
  });
  assert.deepEqual(getVersionNegotiationPayload(SUPPORTED_VERSIONS[0]), {
    supported_versions: SUPPORTED_VERSIONS,
  });
});

test('getVersionNegotiationPayload warns when the extension is newer than the client', () => {
  assert.deepEqual(getVersionNegotiationPayload('0.9'), {
    supported_versions: SUPPORTED_VERSIONS,
    deprecated_since: SUPPORTED_VERSIONS[0],
    migration_hint: `Browser Bridge extension is newer than the client protocol 0.9. Update the Browser Bridge CLI/npm package to ${SUPPORTED_VERSIONS[0]} or later.`,
  });
});

test('getVersionNegotiationPayload warns when the extension is older than the client', () => {
  assert.deepEqual(getVersionNegotiationPayload('9.0'), {
    supported_versions: SUPPORTED_VERSIONS,
    migration_hint:
      'Browser Bridge extension is older than the client protocol 9.0. Update the extension to a build that supports 9.0.',
  });
});
