// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createBridgeMcpServer, startBridgeMcpServer } from '../src/server.js';
import {
  BRIDGE_HOME_ENV,
  BRIDGE_TCP_PORT_ENV,
  DEFAULT_WINDOWS_TCP_PORT,
} from '../../native-host/src/config.js';

test('createBridgeMcpServer registers the full Browser Bridge tool set', () => {
  const originalRegisterTool = McpServer.prototype.registerTool;
  /** @type {{ name: string, config: Record<string, unknown>, handler: unknown }[]} */
  const registrations = [];

  McpServer.prototype.registerTool =
    /** @type {typeof McpServer.prototype.registerTool} */ (
      function registerTool(name, config, handler) {
        registrations.push({
          name,
          config: /** @type {Record<string, unknown>} */ (config),
          handler,
        });
        return /** @type {ReturnType<typeof originalRegisterTool>} */ (
          /** @type {unknown} */ ({
            enabled: true,
            disable() {},
            enable() {},
            handler,
            name,
            remove() {},
          })
        );
      }
    );

  try {
    const server = createBridgeMcpServer();
    const investigateRegistration = registrations.find(
      (entry) => entry.name === 'browser_investigate'
    );
    const investigateConfig = /** @type {Record<string, unknown>} */ (
      investigateRegistration?.config ?? {}
    );
    const investigateMeta =
      investigateConfig._meta && typeof investigateConfig._meta === 'object'
        ? /** @type {Record<string, unknown>} */ (investigateConfig._meta)
        : {};
    const delegationHint = /** @type {Record<string, unknown>} */ (
      investigateMeta.delegationHint ?? {}
    );

    assert.ok(server instanceof McpServer);
    assert.equal(registrations.length, 17);
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
    assert.match(String(registrations[5].config.description), /accessibility_tree/);
    assert.equal(typeof registrations[12].handler, 'function');
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
  } finally {
    McpServer.prototype.registerTool = originalRegisterTool;
  }
});

test('startBridgeMcpServer connects over stdio transport', async () => {
  const originalConnect = McpServer.prototype.connect;
  /** @type {unknown[]} */
  const transports = [];

  McpServer.prototype.connect =
    /** @type {typeof McpServer.prototype.connect} */ (
      async function connect(transport) {
        transports.push(transport);
      }
    );

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

  os.platform = /** @type {typeof os.platform} */ (() => 'win32');
  delete process.env[BRIDGE_TCP_PORT_ENV];
  delete process.env[BRIDGE_HOME_ENV];

  McpServer.prototype.connect =
    /** @type {typeof McpServer.prototype.connect} */ (async function connect() {});

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
