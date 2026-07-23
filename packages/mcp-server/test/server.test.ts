import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createBridgeMcpServer, startBridgeMcpServer } from '../src/server.js';
import { MCP_SERVER_INSTRUCTIONS } from '../src/guidance.js';
import { BRIDGE_METHOD_REGISTRY } from '../../protocol/src/index.js';
import {
  BRIDGE_HOME_ENV,
  BRIDGE_TCP_PORT_ENV,
  DEFAULT_WINDOWS_TCP_PORT,
} from '../../native-host/src/config.js';

type ToolRegistration = {
  name: string;
  config: Record<string, unknown>;
  handler: unknown;
};

test('createBridgeMcpServer registers the full Browser Bridge tool set', () => {
  const originalRegisterTool = McpServer.prototype.registerTool;
  const originalRegisterPrompt = McpServer.prototype.registerPrompt;
  const registrations: ToolRegistration[] = [];
  const promptRegistrations: ToolRegistration[] = [];

  McpServer.prototype.registerTool = function registerTool(
    name: string,
    config: Record<string, unknown>,
    handler: unknown
  ) {
    registrations.push({
      name,
      config,
      handler,
    });
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

  McpServer.prototype.registerPrompt = function registerPrompt(
    name: string,
    config: Record<string, unknown>,
    callback: unknown
  ) {
    promptRegistrations.push({
      name,
      config,
      handler: callback,
    });
    return {
      enabled: true,
      disable() {},
      enable() {},
      callback,
      name,
      remove() {},
      update() {},
    } as unknown as ReturnType<typeof originalRegisterPrompt>;
  } as unknown as typeof McpServer.prototype.registerPrompt;

  try {
    const server = createBridgeMcpServer();
    const investigateRegistration = registrations.find(
      (entry) => entry.name === 'browser_investigate'
    );
    const investigateConfig = investigateRegistration?.config ?? {};
    const investigateMeta =
      investigateConfig._meta && typeof investigateConfig._meta === 'object'
        ? (investigateConfig._meta as Record<string, unknown>)
        : {};
    const delegationHint = (investigateMeta.delegationHint ?? {}) as Record<string, unknown>;

    assert.ok(server instanceof McpServer);
    assert.equal(registrations.length, 18);
    assert.deepEqual(
      registrations.map((entry) => entry.name),
      [
        'browser_status',
        'browser_setup',
        'browser_logs',
        'browser_health',
        'browser_tabs',
        'browser_dom',
        'browser_styles_layout',
        'browser_sensitive_read',
        'browser_page',
        'browser_navigation',
        'browser_input',
        'browser_patch',
        'browser_capture',
        'browser_batch',
        'browser_call',
        'browser_skill',
        'browser_access',
        'browser_investigate',
      ]
    );
    assert.equal(registrations[4].config.title, 'Browser Tabs');
    const tabsSchema = registrations[4].config.inputSchema as Record<string, unknown>;
    const stylesSchema = registrations[6].config.inputSchema as Record<string, unknown>;
    const sensitiveSchema = registrations[7].config.inputSchema as Record<string, unknown>;
    const pageSchema = registrations[8].config.inputSchema as Record<string, unknown>;
    const inputSchema = registrations[10].config.inputSchema as Record<string, unknown>;
    const patchSchema = registrations[11].config.inputSchema as Record<string, unknown>;
    const captureSchema = registrations[12].config.inputSchema as Record<string, unknown>;
    const rawCallSchema = registrations[14].config.inputSchema as Record<string, unknown>;
    const tabsAction = tabsSchema.action as { safeParse: (value: unknown) => { success: boolean } };
    const inputAction = inputSchema.action as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const executionMode = inputSchema.executionMode as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const patchOperation = patchSchema.operation as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const returnByValue = pageSchema.returnByValue as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const pageAction = pageSchema.action as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const harDelivery = pageSchema.delivery as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const urlPattern = pageSchema.urlPattern as {
      safeParse: (value: unknown) => { success: boolean };
    };
    assert.equal(tabsAction.safeParse('activate').success, true);
    assert.equal(inputAction.safeParse('fill').success, true);
    assert.equal(executionMode.safeParse('cdp').success, true);
    assert.equal(executionMode.safeParse('auto').success, false);
    assert.ok(inputSchema.recoverStale);
    assert.match(String(registrations[10].config.description), /Targeted click/);
    assert.match(String(registrations[10].config.description), /separate contracts/);
    assert.match(
      String((inputSchema.recoverStale as { description?: string }).description),
      /not used by cdp_press_key or scroll_into_view/
    );
    assert.match(
      String((stylesSchema.properties as { description?: string }).description),
      /display, position, width, height, and color/
    );
    assert.equal(patchOperation.safeParse('setProperty').success, false);
    assert.equal(patchOperation.safeParse('toggleClass').success, true);
    assert.equal(returnByValue.safeParse(true).success, true);
    assert.equal(returnByValue.safeParse(false).success, false);
    assert.equal(pageAction.safeParse('har').success, true);
    assert.equal(pageAction.safeParse('performance').success, true);
    assert.equal(harDelivery.safeParse('artifact').success, true);
    assert.equal(harDelivery.safeParse('download').success, false);
    assert.equal(urlPattern.safeParse('x'.repeat(2_048)).success, true);
    assert.equal(urlPattern.safeParse('x'.repeat(2_049)).success, false);
    assert.ok(sensitiveSchema.source);
    assert.ok(sensitiveSchema.key);
    assert.ok(rawCallSchema.budgetPreset);
    assert.match(String((patchSchema.patchId as { description?: string }).description), /required/);
    assert.ok(inputSchema.value);
    assert.ok(inputSchema.mode);
    assert.ok(captureSchema.computedStyles);
    assert.deepEqual(BRIDGE_METHOD_REGISTRY['cdp.get_dom_snapshot'].params, ['computedStyles']);
    assert.match(String(registrations[5].config.description), /accessibility_tree/);
    assert.match(String(registrations[8].config.description), /raw CDP Performance\.getMetrics/);
    assert.match(String(registrations[8].config.description), /names and units, which vary/);
    assert.match(String(registrations[8].config.description), /no navigation observation window/);
    assert.match(String(registrations[8].config.description), /does not measure LCP, CLS, or INP/);
    assert.match(
      String((pageSchema.action as { description?: string }).description),
      /raw Chrome\/CDP counters, not LCP, CLS, or INP/
    );
    assert.equal(typeof registrations[13].handler, 'function');
    assert.deepEqual(registrations[13].config.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    assert.match(String(investigateConfig.description), /smaller, low-cost subagent/);
    assert.doesNotMatch(String(investigateConfig.description), /Haiku|GPT-/);
    assert.equal(delegationHint.costTier, 'low');
    assert.deepEqual(delegationHint.preferredAgentProfile, {
      modelClass: 'small',
      reasoningEffort: 'low',
    });
    assert.deepEqual(delegationHint.preferredTools, [
      'browser_dom',
      'browser_page',
      'browser_styles_layout',
      'browser_batch',
    ]);
    assert.deepEqual(delegationHint.escalationTools, ['browser_capture']);
    assert.ok(
      Array.isArray(delegationHint.preferredBridgeMethods) &&
        delegationHint.preferredBridgeMethods.includes('page.get_state')
    );
    assert.ok(
      Array.isArray(delegationHint.preferredBridgeMethods) &&
        !delegationHint.preferredBridgeMethods.includes('screenshot.capture_full_page')
    );
    assert.match(MCP_SERVER_INSTRUCTIONS, /Prefer Browser Bridge MCP tools/);
    assert.match(MCP_SERVER_INSTRUCTIONS, /Page investigation:/);
    assert.match(MCP_SERVER_INSTRUCTIONS, /Layout debugging:/);
    assert.match(MCP_SERVER_INSTRUCTIONS, /Flow verification:/);
    assert.deepEqual(promptRegistrations, []);
  } finally {
    McpServer.prototype.registerTool = originalRegisterTool;
    McpServer.prototype.registerPrompt = originalRegisterPrompt;
  }
});

test('startBridgeMcpServer connects over stdio transport', async () => {
  const originalConnect = McpServer.prototype.connect;
  const transports: unknown[] = [];

  McpServer.prototype.connect = async function connect(transport: unknown): Promise<void> {
    transports.push(transport);
  } as unknown as typeof McpServer.prototype.connect;

  try {
    await startBridgeMcpServer();

    assert.equal(transports.length, 1);
    assert.ok(transports[0] instanceof StdioServerTransport);
  } finally {
    McpServer.prototype.connect = originalConnect;
  }
});

test('startBridgeMcpServer seeds the Windows TCP default before connecting', async () => {
  const originalPlatform = os.platform;
  const originalTcpPort = process.env[BRIDGE_TCP_PORT_ENV];
  const originalBridgeHome = process.env[BRIDGE_HOME_ENV];
  const originalConnect = McpServer.prototype.connect;

  os.platform = (() => 'win32') as typeof os.platform;
  delete process.env[BRIDGE_TCP_PORT_ENV];
  delete process.env[BRIDGE_HOME_ENV];

  McpServer.prototype.connect =
    async function connect(): Promise<void> {} as typeof McpServer.prototype.connect;

  try {
    await startBridgeMcpServer();

    assert.equal(process.env[BRIDGE_TCP_PORT_ENV], String(DEFAULT_WINDOWS_TCP_PORT));
  } finally {
    McpServer.prototype.connect = originalConnect;
    os.platform = originalPlatform;
    if (originalTcpPort === undefined) {
      delete process.env[BRIDGE_TCP_PORT_ENV];
    } else {
      process.env[BRIDGE_TCP_PORT_ENV] = originalTcpPort;
    }
    if (originalBridgeHome === undefined) {
      delete process.env[BRIDGE_HOME_ENV];
    } else {
      process.env[BRIDGE_HOME_ENV] = originalBridgeHome;
    }
  }
});
