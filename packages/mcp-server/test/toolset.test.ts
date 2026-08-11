import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import {
  INITIAL_TOOLSET_TOOLS,
  isInitiallyEnabledTool,
  isToolEnabledForEra,
  LOADABLE_TOOLSET_TOOLS,
  MODERN_TOOLSET_TOOLS,
} from '../src/toolset.js';
import {
  getMcpServerInstructions,
  MCP_SERVER_INSTRUCTIONS,
  MODERN_MCP_SERVER_INSTRUCTIONS,
} from '../src/guidance.js';
import { createBridgeMcpServer } from '../src/server.js';

test('toolset exposes one fixed initial surface and exact loadable tool names', () => {
  assert.deepEqual(INITIAL_TOOLSET_TOOLS, [
    'browser_access',
    'browser_batch',
    'browser_call',
    'browser_health',
    'browser_status',
    'browser_toolset',
  ]);
  assert.deepEqual(LOADABLE_TOOLSET_TOOLS, [
    'browser_dom',
    'browser_styles_layout',
    'browser_page',
    'browser_logs',
    'browser_input',
    'browser_navigation',
    'browser_tabs',
    'browser_capture',
    'browser_artifact',
    'browser_patch',
    'browser_intercept',
    'browser_investigate',
    'browser_sensitive_read',
    'browser_setup',
    'browser_skill',
  ]);
  assert.equal(isInitiallyEnabledTool('browser_call'), true);
  assert.equal(isInitiallyEnabledTool('browser_toolset'), true);
  assert.equal(isInitiallyEnabledTool('browser_dom'), false);
  assert.deepEqual(MODERN_TOOLSET_TOOLS, [
    'browser_access',
    'browser_batch',
    'browser_call',
    'browser_health',
    'browser_skill',
    'browser_status',
  ]);
  assert.equal(isToolEnabledForEra('browser_skill', 'modern'), true);
  assert.equal(isToolEnabledForEra('browser_toolset', 'modern'), false);
  assert.equal(
    INITIAL_TOOLSET_TOOLS.some((toolName) => new Set<string>(LOADABLE_TOOLSET_TOOLS).has(toolName)),
    false
  );
});

test('server keeps loadable tools registered but disabled until requested', () => {
  const originalRegisterTool = McpServer.prototype.registerTool;
  const registrations: Array<{
    name: string;
    enabled: boolean;
    disableCalls: number;
    removeCalls: number;
  }> = [];

  McpServer.prototype.registerTool = function registerTool(
    this: McpServer,
    name: string,
    _config: Record<string, unknown>,
    handler: unknown
  ) {
    const state = { name, enabled: true, disableCalls: 0, removeCalls: 0 };
    registrations.push(state);
    return {
      get enabled() {
        return state.enabled;
      },
      disable() {
        state.disableCalls += 1;
        state.enabled = false;
      },
      enable() {
        state.enabled = true;
      },
      handler,
      name,
      remove() {
        state.removeCalls += 1;
      },
      update() {},
    } as unknown as ReturnType<typeof originalRegisterTool>;
  } as unknown as typeof McpServer.prototype.registerTool;

  try {
    createBridgeMcpServer();
  } finally {
    McpServer.prototype.registerTool = originalRegisterTool;
  }

  const enabled = registrations
    .filter((registration) => registration.enabled)
    .map(({ name }) => name);
  const disabled = registrations.filter((registration) => !registration.enabled);
  assert.equal(registrations.length, 21);
  assert.deepEqual(enabled.sort(), [...INITIAL_TOOLSET_TOOLS].sort());
  assert.deepEqual(disabled.map(({ name }) => name).sort(), [...LOADABLE_TOOLSET_TOOLS].sort());
  assert.equal(
    disabled.every((registration) => registration.disableCalls === 1),
    true
  );
  assert.equal(
    registrations.every((registration) => registration.removeCalls === 0),
    true
  );
});

test('investigate metadata only names tools available before expansion', () => {
  const originalRegisterTool = McpServer.prototype.registerTool;
  let captured: Record<string, unknown> | null = null;

  McpServer.prototype.registerTool = function registerTool(
    this: McpServer,
    name: string,
    config: Record<string, unknown>,
    handler: unknown
  ) {
    if (name === 'browser_investigate') captured = config;
    return {
      enabled: true,
      disable() {},
      enable() {},
      handler,
      name,
      remove() {},
      update() {},
    } as unknown as ReturnType<typeof originalRegisterTool>;
  } as unknown as typeof McpServer.prototype.registerTool;

  try {
    createBridgeMcpServer();
  } finally {
    McpServer.prototype.registerTool = originalRegisterTool;
  }

  assert.ok(captured);
  const config = captured as Record<string, unknown>;
  const hint = (config._meta as Record<string, unknown>).delegationHint as Record<string, unknown>;
  assert.deepEqual(hint.preferredTools, ['browser_call', 'browser_batch']);
  assert.deepEqual(hint.escalationTools, ['browser_call']);
  assert.match(String(config.description), /browser_call and browser_batch/);
  assert.doesNotMatch(String(config.description), /browser_dom|browser_capture/);
});

test('instructions teach exact-name loading without profile terminology', () => {
  const instructions = getMcpServerInstructions();

  assert.equal(instructions, MCP_SERVER_INSTRUCTIONS);
  assert.match(instructions, /common tools are available immediately/i);
  assert.match(instructions, /browser_toolset with its exact tool name/);
  assert.match(instructions, /protocol\.describe/);
  assert.doesNotMatch(instructions, /minimal profile|full profile|toolset profile/i);
  assert.match(instructions, /Page investigation:/);
  assert.match(instructions, /Layout debugging:/);
  assert.match(instructions, /Flow verification:/);
});

test('modern instructions describe a static stateless surface', () => {
  const instructions = getMcpServerInstructions('modern');

  assert.equal(instructions, MODERN_MCP_SERVER_INSTRUCTIONS);
  assert.match(instructions, /tool list is static for stateless MCP/i);
  assert.match(instructions, /browser_skill/);
  assert.doesNotMatch(instructions, /call browser_toolset/i);
});
