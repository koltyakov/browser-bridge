// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getActivitySourceTag,
  getPromptExamplesMode,
  shouldAutoExpandHostSetup,
} from '../src/sidepanel-helpers.js';

test('shouldAutoExpandHostSetup returns true when no MCP or CLI skill is installed', () => {
  assert.equal(
    shouldAutoExpandHostSetup({
      mcpClients: [{ configured: false }, { configured: false }],
      skillTargets: [{ skills: [{ exists: false }, { exists: false }] }, { skills: [] }],
    }),
    true
  );
});

test('shouldAutoExpandHostSetup returns false when any MCP client is configured', () => {
  assert.equal(
    shouldAutoExpandHostSetup({
      mcpClients: [{ configured: false }, { configured: true }],
      skillTargets: [{ skills: [{ exists: false }] }],
    }),
    false
  );
});

test('shouldAutoExpandHostSetup returns false when any CLI skill exists', () => {
  assert.equal(
    shouldAutoExpandHostSetup({
      mcpClients: [{ configured: false }],
      skillTargets: [{ skills: [{ exists: false }] }, { skills: [{ exists: true }] }],
    }),
    false
  );
});

test('getPromptExamplesMode returns grouped when setup status is unavailable', () => {
  assert.equal(getPromptExamplesMode(null), 'grouped');
});

test('getPromptExamplesMode returns mcp when only MCP is configured', () => {
  assert.equal(
    getPromptExamplesMode({
      mcpClients: [{ configured: true }],
      skillTargets: [{ skills: [{ exists: false }] }],
    }),
    'mcp'
  );
});

test('getPromptExamplesMode returns cli when only CLI skill exists', () => {
  assert.equal(
    getPromptExamplesMode({
      mcpClients: [{ configured: false }],
      skillTargets: [{ skills: [{ exists: true }] }],
    }),
    'cli'
  );
});

test('getPromptExamplesMode returns grouped when both MCP and CLI skill exist', () => {
  assert.equal(
    getPromptExamplesMode({
      mcpClients: [{ configured: true }],
      skillTargets: [{ skills: [{ exists: true }] }],
    }),
    'grouped'
  );
});

test('getActivitySourceTag prefers explicit source metadata', () => {
  assert.equal(getActivitySourceTag('mcp', null), 'mcp');
  assert.equal(
    getActivitySourceTag('cli', {
      mcpClients: [{ configured: true }],
      skillTargets: [{ skills: [{ exists: true }] }],
    }),
    'cli'
  );
});

test('getActivitySourceTag infers MCP when only MCP is configured', () => {
  assert.equal(
    getActivitySourceTag('', {
      mcpClients: [{ configured: true }],
      skillTargets: [{ skills: [{ exists: false }] }],
    }),
    'mcp'
  );
});

test('getActivitySourceTag infers CLI when only CLI skill is installed', () => {
  assert.equal(
    getActivitySourceTag('', {
      mcpClients: [{ configured: false }],
      skillTargets: [{ skills: [{ exists: true }] }],
    }),
    'cli'
  );
});

test('getActivitySourceTag does not guess when setup is ambiguous', () => {
  assert.equal(getActivitySourceTag('', null), '');
  assert.equal(
    getActivitySourceTag('', {
      mcpClients: [{ configured: true }],
      skillTargets: [{ skills: [{ exists: true }] }],
    }),
    ''
  );
});
