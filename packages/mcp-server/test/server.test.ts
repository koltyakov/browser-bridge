import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
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

function getInputSchemaShape(registration: ToolRegistration): Record<string, unknown> {
  const schema = registration.config.inputSchema as { shape?: Record<string, unknown> } | undefined;
  assert.ok(schema?.shape, `expected Zod object input schema for ${registration.name}`);
  return schema.shape;
}

test('createBridgeMcpServer registers all tools behind one progressive surface', () => {
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
    assert.equal(registrations.length, 21);
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
        'browser_artifact',
        'browser_intercept',
        'browser_batch',
        'browser_call',
        'browser_skill',
        'browser_access',
        'browser_investigate',
        'browser_toolset',
      ]
    );
    assert.equal(registrations[4].config.title, 'Browser Tabs');
    const tabsSchema = getInputSchemaShape(registrations[4]);
    const stylesSchema = getInputSchemaShape(registrations[6]);
    const sensitiveSchema = getInputSchemaShape(registrations[7]);
    const pageSchema = getInputSchemaShape(registrations[8]);
    const inputSchema = getInputSchemaShape(registrations[10]);
    const patchSchema = getInputSchemaShape(registrations[11]);
    const captureSchema = getInputSchemaShape(registrations[12]);
    const artifactSchema = getInputSchemaShape(registrations[13]);
    const interceptSchema = getInputSchemaShape(registrations[14]);
    const rawCallSchema = getInputSchemaShape(registrations[16]);
    const toolsetSchema = getInputSchemaShape(registrations[20]);
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
    const loadableTool = toolsetSchema.tool as {
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
    assert.equal(loadableTool.safeParse('browser_dom').success, true);
    assert.equal(loadableTool.safeParse('browser_status').success, false);
    assert.equal(loadableTool.safeParse('all').success, false);
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
    assert.equal(typeof registrations[15].handler, 'function');
    assert.deepEqual(registrations[15].config.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const artifactAction = artifactSchema.action as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const interceptAction = interceptSchema.action as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const ruleAction = interceptSchema.ruleAction as {
      safeParse: (value: unknown) => { success: boolean };
    };
    assert.equal(artifactAction.safeParse('read').success, true);
    assert.equal(artifactAction.safeParse('delete').success, true);
    assert.equal(artifactAction.safeParse('download').success, false);
    assert.ok(artifactSchema.artifactId);
    assert.ok(artifactSchema.offset);
    assert.ok(artifactSchema.limit);
    assert.equal(interceptAction.safeParse('add').success, true);
    assert.equal(interceptAction.safeParse('clear').success, true);
    assert.equal(interceptAction.safeParse('block').success, false);
    assert.equal(ruleAction.safeParse('fulfill').success, true);
    assert.equal(ruleAction.safeParse('redirect').success, false);
    assert.ok(interceptSchema.urlPattern);
    assert.ok(interceptSchema.ruleId);
    assert.match(String(investigateConfig.description), /smaller, low-cost subagent/);
    assert.doesNotMatch(String(investigateConfig.description), /Haiku|GPT-/);
    assert.equal(delegationHint.costTier, 'low');
    assert.deepEqual(delegationHint.preferredAgentProfile, {
      modelClass: 'small',
      reasoningEffort: 'low',
    });
    assert.deepEqual(delegationHint.preferredTools, ['browser_call', 'browser_batch']);
    assert.deepEqual(delegationHint.escalationTools, ['browser_call']);
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

test('browser_toolset loads one exact tool at a time and is idempotent', async () => {
  const originalRegisterTool = McpServer.prototype.registerTool;
  const registrations = new Map<
    string,
    { enabled: boolean; enableCalls: number; handler: unknown }
  >();

  McpServer.prototype.registerTool = function registerTool(
    name: string,
    _config: Record<string, unknown>,
    handler: unknown
  ) {
    const state = { enabled: true, enableCalls: 0, handler };
    registrations.set(name, state);
    return {
      get enabled() {
        return state.enabled;
      },
      disable() {
        state.enabled = false;
      },
      enable() {
        state.enabled = true;
        state.enableCalls += 1;
      },
      handler,
      name,
      remove() {},
      update() {},
    } as unknown as ReturnType<typeof originalRegisterTool>;
  } as unknown as typeof McpServer.prototype.registerTool;

  try {
    createBridgeMcpServer();
    const toolset = registrations.get('browser_toolset');
    assert.ok(toolset);
    assert.equal(registrations.size, 21);

    const handler = toolset.handler as (
      args: {
        tool: string;
      },
      context: { mcpReq: { signal: AbortSignal } }
    ) =>
      | { structuredContent: Record<string, unknown> }
      | Promise<{ structuredContent: Record<string, unknown> }>;
    const load = async (tool: string): Promise<Record<string, unknown>> => {
      const result = await handler({ tool }, { mcpReq: { signal: new AbortController().signal } });
      return {
        tool: result.structuredContent.tool,
        newlyEnabled: result.structuredContent.newlyEnabled,
      };
    };

    assert.deepEqual(await load('browser_dom'), { tool: 'browser_dom', newlyEnabled: true });
    assert.deepEqual(await load('browser_dom'), { tool: 'browser_dom', newlyEnabled: false });
    assert.deepEqual(await load('browser_input'), { tool: 'browser_input', newlyEnabled: true });
    assert.equal(
      [...registrations.values()].filter((registration) => registration.enabled).length,
      8
    );
    assert.equal(
      [...registrations.values()].reduce(
        (total, registration) => total + registration.enableCalls,
        0
      ),
      2
    );
  } finally {
    McpServer.prototype.registerTool = originalRegisterTool;
  }
});

test('startBridgeMcpServer serves an era-aware stdio factory', () => {
  const eras: string[] = [];

  startBridgeMcpServer({
    serve(factory) {
      const modern = factory({ era: 'modern' });
      const legacy = factory({ era: 'legacy' });
      assert.ok(modern instanceof McpServer);
      assert.ok(legacy instanceof McpServer);
      eras.push('modern', 'legacy');
      return { close: async () => {} };
    },
  });

  assert.deepEqual(eras, ['modern', 'legacy']);
});

test('startBridgeMcpServer seeds the Windows TCP default before connecting', async () => {
  const originalPlatform = os.platform;
  const originalTcpPort = process.env[BRIDGE_TCP_PORT_ENV];
  const originalBridgeHome = process.env[BRIDGE_HOME_ENV];

  os.platform = (() => 'win32') as typeof os.platform;
  delete process.env[BRIDGE_TCP_PORT_ENV];
  delete process.env[BRIDGE_HOME_ENV];

  try {
    startBridgeMcpServer({
      serve() {
        return { close: async () => {} };
      },
    });

    assert.equal(process.env[BRIDGE_TCP_PORT_ENV], String(DEFAULT_WINDOWS_TCP_PORT));
  } finally {
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
