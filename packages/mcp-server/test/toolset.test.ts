import test from 'node:test';
import assert from 'node:assert/strict';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  createToolFilter,
  DEFAULT_TOOLSET_PROFILE,
  isToolsetProfile,
  MINIMAL_TOOLSET_TOOLS,
  resolveToolsetProfile,
  TOOLSET_PROFILE_ENV,
  TOOLSET_PROFILES,
} from '../src/toolset.js';
import { getMcpServerInstructions, MCP_SERVER_INSTRUCTIONS } from '../src/guidance.js';
import { createBridgeMcpServer } from '../src/server.js';

test('resolveToolsetProfile defaults to full when unset or blank', () => {
  assert.equal(resolveToolsetProfile({}), 'full');
  assert.equal(resolveToolsetProfile({ [TOOLSET_PROFILE_ENV]: '' }), 'full');
  assert.equal(resolveToolsetProfile({ [TOOLSET_PROFILE_ENV]: '   ' }), 'full');
  assert.equal(DEFAULT_TOOLSET_PROFILE, 'full');
});

test('resolveToolsetProfile accepts known profiles case-insensitively', () => {
  assert.equal(resolveToolsetProfile({ [TOOLSET_PROFILE_ENV]: 'minimal' }), 'minimal');
  assert.equal(resolveToolsetProfile({ [TOOLSET_PROFILE_ENV]: '  MINIMAL ' }), 'minimal');
  assert.equal(resolveToolsetProfile({ [TOOLSET_PROFILE_ENV]: 'Full' }), 'full');
});

test('resolveToolsetProfile warns and falls back on an unknown profile', () => {
  const warnings: string[] = [];
  const profile = resolveToolsetProfile(
    { [TOOLSET_PROFILE_ENV]: 'tiny' },
    { warn: (message) => warnings.push(message) }
  );

  assert.equal(profile, 'full');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ignoring unknown BBX_MCP_TOOLSET value "tiny"/);
  assert.match(warnings[0], /full, minimal/);
});

test('isToolsetProfile narrows only to known profiles', () => {
  assert.equal(isToolsetProfile('full'), true);
  assert.equal(isToolsetProfile('minimal'), true);
  assert.equal(isToolsetProfile('tiny'), false);
  assert.equal(isToolsetProfile(undefined), false);
  assert.equal(isToolsetProfile(3), false);
  assert.deepEqual([...TOOLSET_PROFILES], ['full', 'minimal']);
});

test('createToolFilter admits everything for full and only the allowlist for minimal', () => {
  const full = createToolFilter('full');
  const minimal = createToolFilter('minimal');

  assert.equal(full('browser_dom'), true);
  assert.equal(full('browser_call'), true);
  assert.equal(minimal('browser_call'), true);
  assert.equal(minimal('browser_batch'), true);
  assert.equal(minimal('browser_dom'), false);
  assert.equal(minimal('browser_investigate'), false);
});

/**
 * Collect the tool names a profile actually exposes, driving the real server so
 * the assertion covers registration rather than the filter in isolation.
 */
function registeredToolNames(profile: 'full' | 'minimal'): string[] {
  const originalRegisterTool = McpServer.prototype.registerTool;
  const registered = new Set<string>();

  McpServer.prototype.registerTool = function registerTool(
    this: McpServer,
    name: string,
    config: Record<string, unknown>,
    handler: unknown
  ) {
    registered.add(name);
    return {
      enabled: true,
      disable() {},
      enable() {},
      handler,
      name,
      remove() {
        registered.delete(name);
      },
      update() {},
    } as unknown as ReturnType<typeof originalRegisterTool>;
  } as unknown as typeof McpServer.prototype.registerTool;

  try {
    createBridgeMcpServer({ profile });
    return [...registered];
  } finally {
    McpServer.prototype.registerTool = originalRegisterTool;
  }
}

test('minimal profile registers only the generic dispatch and readiness tools', () => {
  const minimal = registeredToolNames('minimal');

  assert.deepEqual(minimal.sort(), [...MINIMAL_TOOLSET_TOOLS].sort());
  assert.equal(minimal.length, 5);
  assert.ok(minimal.includes('browser_call'));
  assert.ok(!minimal.includes('browser_dom'));
  assert.ok(!minimal.includes('browser_page'));
});

test('full profile stays the complete tool surface', () => {
  const full = registeredToolNames('full');

  assert.equal(full.length, 18);
  assert.ok(full.includes('browser_dom'));
  assert.ok(full.includes('browser_investigate'));
});

test('minimal instructions drop guidance for tools the profile does not register', () => {
  const minimal = getMcpServerInstructions('minimal');

  assert.match(minimal, /minimal tool profile/);
  assert.match(minimal, /browser_call reaches every bridge method by name/);
  assert.doesNotMatch(minimal, /browser_page, browser_dom/);
  assert.doesNotMatch(minimal, /Only use the specialized Browser Bridge MCP tools/);

  // Workflow guidance is profile-independent and must survive the trim.
  assert.match(minimal, /Page investigation:/);
  assert.match(minimal, /Layout debugging:/);
  assert.match(minimal, /Flow verification:/);
});

test('full instructions are unchanged by the profile split', () => {
  assert.equal(getMcpServerInstructions(), MCP_SERVER_INSTRUCTIONS);
  assert.equal(getMcpServerInstructions('full'), MCP_SERVER_INSTRUCTIONS);
  assert.match(MCP_SERVER_INSTRUCTIONS, /Only use the specialized Browser Bridge MCP tools/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /use browser_call as the default/);
});

test('resolveToolsetProfile reports unknown values on stderr by default', () => {
  const originalWrite = process.stderr.write;
  const written: string[] = [];

  // The default warn path must use stderr: stdout carries the MCP protocol.
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const profile = resolveToolsetProfile({ [TOOLSET_PROFILE_ENV]: 'huge' });
    assert.equal(profile, 'full');
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(written.length, 1);
  assert.match(written[0], /ignoring unknown BBX_MCP_TOOLSET value "huge"/);
  assert.match(written[0], /\n$/);
});
