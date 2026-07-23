import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BUDGET_PRESETS,
  BRIDGE_METHOD_REGISTRY,
  DEFAULT_PAGE_TEXT_BUDGET,
} from '../../protocol/src/index.js';
import { BridgeClient } from '../../agent-client/src/client.js';
import { BUDGET_PRESET_DESCRIPTION } from '../src/server.js';
import {
  CAPTURE_ACTIONS,
  DOM_ACTIONS,
  INPUT_ACTION_METHODS,
  NAVIGATION_ACTIONS,
  PAGE_ACTIONS,
  PATCH_ACTIONS,
  STYLES_LAYOUT_ACTIONS,
  handleBatchTool,
  handleCaptureTool,
  handleDomTool,
  handleInputTool,
  handleLogTool,
  handleNavigationTool,
  handlePageTool,
  handlePatchTool,
  handleRawCallTool,
  handleSetupTool,
  handleSkillTool,
  handleStatusTool,
  handleStylesLayoutTool,
  handleTabsTool,
  handleInvestigateTool,
} from '../src/handlers.js';
import {
  makeFailure as fail,
  makeSuccess as ok,
} from '../../../tests/_helpers/protocolFactories.ts';
import type { BridgeMethod, BridgeMeta, BridgeResponse } from '../../protocol/src/types.js';

type RequestRecord = {
  method: BridgeMethod;
  params?: Record<string, unknown>;
  tabId?: number | null;
  meta?: BridgeMeta;
};

type BatchResult = {
  method: string;
  ok?: boolean;
  summary?: string;
  durationMs?: number;
  approxTokens?: number;
  meta?: unknown;
};

type InvestigationStep = {
  method: string;
  ok: boolean;
  summary?: string;
  evidence?: unknown;
  durationMs?: number;
};

type BridgeRequestOptions = {
  method: BridgeMethod;
  params?: Record<string, unknown>;
  tabId?: number | null;
  meta?: BridgeMeta;
  timeoutMs?: number;
};

const REMOTE_TOKEN = '6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237';
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function withBridgeHome(callback: (bridgeHome: string) => Promise<void>): Promise<void> {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-mcp-remotes-test-'));
  const originalBridgeHome = process.env.BROWSER_BRIDGE_HOME;
  process.env.BROWSER_BRIDGE_HOME = bridgeHome;
  try {
    await callback(bridgeHome);
  } finally {
    if (originalBridgeHome === undefined) {
      delete process.env.BROWSER_BRIDGE_HOME;
    } else {
      process.env.BROWSER_BRIDGE_HOME = originalBridgeHome;
    }
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
}

async function writeRemoteConfig(bridgeHome: string): Promise<void> {
  await fs.promises.writeFile(
    path.join(bridgeHome, 'remotes.json'),
    `${JSON.stringify(
      {
        remotes: [{ id: 'vm-private', host: '10.0.0.5', port: 9223, token: REMOTE_TOKEN }],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function withMockedBridge(
  responder: (record: RequestRecord, index: number) => Promise<BridgeResponse>,
  callback: (calls: RequestRecord[]) => Promise<void>,
  options: { isolateBridgeHome?: boolean } = {}
): Promise<void> {
  const originalConnect = BridgeClient.prototype.connect;
  const originalClose = BridgeClient.prototype.close;
  const originalRequest = BridgeClient.prototype.request;
  const originalBridgeHome = process.env.BROWSER_BRIDGE_HOME;
  const isolateBridgeHome = options.isolateBridgeHome ?? true;
  const bridgeHome = isolateBridgeHome
    ? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-mcp-bridge-test-'))
    : null;
  const calls: RequestRecord[] = [];

  if (bridgeHome) {
    process.env.BROWSER_BRIDGE_HOME = bridgeHome;
  }

  BridgeClient.prototype.connect = async function connect() {
    assert.equal(this.checkProtocolOnConnect, false);
    this.connected = true;
  };
  BridgeClient.prototype.close = async function close() {};
  BridgeClient.prototype.request = async function request({
    method,
    params = {},
    tabId = null,
    meta = {},
  }: BridgeRequestOptions): Promise<BridgeResponse> {
    const record = { method, params, tabId, meta };
    calls.push(record);
    return responder(record, calls.length - 1);
  };

  try {
    await callback(calls);
  } finally {
    BridgeClient.prototype.connect = originalConnect;
    BridgeClient.prototype.close = originalClose;
    BridgeClient.prototype.request = originalRequest;
    if (bridgeHome) {
      if (originalBridgeHome === undefined) {
        delete process.env.BROWSER_BRIDGE_HOME;
      } else {
        process.env.BROWSER_BRIDGE_HOME = originalBridgeHome;
      }
      await fs.promises.rm(bridgeHome, { recursive: true, force: true });
    }
  }
}

test('handleTabsTool maps list to tabs.list and returns summarized output', async () => {
  await withMockedBridge(
    async () =>
      ok({
        tabs: [
          {
            tabId: 4,
            active: true,
            origin: 'https://example.com',
            title: 'Example',
          },
        ],
      }),
    async (calls) => {
      const result = await handleTabsTool({ action: 'list' });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'tabs.list');
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /Bridge listed 1 tab/);
      assert.equal(result.structuredContent.ok, true);
    }
  );
});

test('handleTabsTool aggregates local and remote tabs when remotes are configured', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async (_record, index) =>
        ok({
          tabs: [
            {
              tabId: index === 0 ? 4 : 8,
              active: true,
              origin: index === 0 ? 'https://local.example' : 'https://private.example',
              title: index === 0 ? 'Local' : 'Remote',
            },
          ],
        }),
      async (calls) => {
        const result = await handleTabsTool({ action: 'list' });

        assert.equal(calls.length, 2);
        assert.deepEqual(
          calls.map((call) => call.method),
          ['tabs.list', 'tabs.list']
        );
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Listed 2 tab\(s\) across 2 destination/);
        assert.equal(result.structuredContent.ok, true);
        assert.deepEqual(result.structuredContent.tabs, [
          {
            destinationId: 'local',
            tabId: 4,
            active: true,
            origin: 'https://local.example',
            title: 'Local',
          },
          {
            destinationId: 'vm-private',
            tabId: 8,
            active: true,
            origin: 'https://private.example',
            title: 'Remote',
          },
        ]);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('handleTabsTool marks aggregate discovery as failed when every destination fails', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async () => fail('ACCESS_DENIED', 'No browser route.'),
      async () => {
        const result = await handleTabsTool({ action: 'list' });

        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.ok, false);
        assert.equal(result.structuredContent.tabs instanceof Array, true);
        assert.equal((result.structuredContent.tabs as unknown[]).length, 0);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('handleTabsTool forwards active for tabs.create', async () => {
  await withMockedBridge(
    async () => ok({ tabId: 4, url: 'https://example.com', active: false }),
    async (calls) => {
      const result = await handleTabsTool({
        action: 'create',
        url: 'https://example.com',
        active: false,
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'tabs.create');
      assert.equal(calls[0].params?.active, false);
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleDomTool uses default active-tab routing when no tabId is provided', async () => {
  await withMockedBridge(
    async (record) => {
      assert.equal(record.method, 'dom.query');
      assert.equal(record.tabId, null);
      return ok({
        nodes: [
          {
            elementRef: 'el_main',
            tag: 'main',
            attrs: {},
            bbox: {},
            textExcerpt: 'Hello',
          },
        ],
      });
    },
    async (calls) => {
      const result = await handleDomTool({ action: 'query', selector: 'main' });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].tabId, null);
      assert.match(result.content[0].text, /DOM query returned 1 element/);
      assert.equal(result.structuredContent.ok, true);
    }
  );
});

test('handleTabsTool translates bridge failures into MCP tool errors', async () => {
  await withMockedBridge(
    async () => fail('ACCESS_DENIED', 'Denied'),
    async () => {
      const result = await handleTabsTool({ action: 'list' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /ACCESS_DENIED/);
      assert.equal(result.structuredContent.ok, false);
    }
  );
});

test('handleTabsTool retries one transient bridge failure', async () => {
  await withMockedBridge(
    async (_record, index) => {
      if (index === 0) {
        return fail('TIMEOUT', 'Slow page text');
      }
      return ok({
        tabs: [
          {
            tabId: 4,
            active: true,
            origin: 'https://example.com',
            title: 'Example',
          },
        ],
      });
    },
    async (calls) => {
      const result = await handleTabsTool({ action: 'list' });

      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, 'tabs.list');
      assert.equal(calls[1].method, 'tabs.list');
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.ok, true);
    }
  );
});

test('handleInputTool does not retry non-idempotent actions', async () => {
  await withMockedBridge(
    async () => fail('TIMEOUT', 'Click may still have reached the page'),
    async (calls) => {
      const result = await handleInputTool({ action: 'click', elementRef: 'el_1' });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'input.click');
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.ok, false);
    }
  );
});

test('handleTabsTool does not retry non-retriable bridge failures', async () => {
  await withMockedBridge(
    async () => fail('ACCESS_DENIED', 'Denied'),
    async (calls) => {
      const result = await handleTabsTool({ action: 'list' });

      assert.equal(calls.length, 1);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.ok, false);
    }
  );
});

test('handleTabsTool honors a non-retryable wire recovery contract', async () => {
  await withMockedBridge(
    async () => {
      const response = fail('TIMEOUT', 'Remote timeout');
      if (!response.ok) {
        response.error.recovery = {
          retry: false,
          hint: 'Do not retry this remote timeout.',
        };
      }
      return response;
    },
    async (calls) => {
      const result = await handleTabsTool({ action: 'list' });
      assert.equal(calls.length, 1);
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent.recovery, {
        retry: false,
        hint: 'Do not retry this remote timeout.',
      });
      assert.match(result.content[0].text, /Do not retry this remote timeout/);
    }
  );
});

test('specialized tools preserve thrown transport error codes', async () => {
  await withMockedBridge(
    async () => {
      const error = new Error('Bridge transport timed out') as Error & { code: string };
      error.code = 'TIMEOUT';
      throw error;
    },
    async () => {
      const result = await handleTabsTool({ action: 'list' });
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent.error as { code: string }).code, 'TIMEOUT');
      assert.ok(result.structuredContent.recovery);
    }
  );
});

test('handleRawCallTool rejects unsupported methods without calling the bridge', async () => {
  await withMockedBridge(
    async () => ok({}),
    async (calls) => {
      const result = await handleRawCallTool({
        method: 'not.real',
        params: {},
      });
      assert.equal(calls.length, 0);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unknown bridge method/);
    }
  );
});

test(
  'handleStatusTool returns doctor report without bridge calls',
  { timeout: 5_000 },
  async () => {
    await withBridgeHome(async () => {
      const result = await handleStatusTool();
      // Either success or error - the key is it must return a ToolResult, never throw.
      assert.ok(typeof result.structuredContent === 'object');
      assert.ok(Array.isArray(result.content));
      assert.equal(result.content[0].type, 'text');
      assert.match(result.content[0].text, /readiness issue|Browser Bridge is ready/);
      assert.doesNotMatch(result.content[0].text, /setup issue/);
    });
  }
);

test('handleStatusTool limits an explicit local check to the local destination', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async ({ method }) => {
        if (method === 'health.ping') {
          return ok({
            daemon: 'ok',
            extensionConnected: true,
            access: { enabled: true, routeReady: true, routeTabId: 17 },
          });
        }
        if (method === 'log.tail') return ok({ entries: [] });
        return ok({});
      },
      async (calls) => {
        const result = await handleStatusTool({ destinationId: 'local' });
        const destinations = result.structuredContent.destinations as Array<{
          id: string;
          local: boolean;
        }>;

        assert.deepEqual(
          destinations.map(({ id, local }) => ({ id, local })),
          [{ id: 'local', local: true }]
        );
        assert.equal(calls.length, 0);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('handleSetupTool reports optional agent integration status', async () => {
  const result = await handleSetupTool({ global: false });

  assert.match(result.content[0].text, /Optional agent integration status:/);
  assert.doesNotMatch(result.content[0].text, /No MCP or skill setup found/);
});

test('handleSkillTool returns runtime context without a bridge connection', async () => {
  const result = await handleSkillTool();
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Runtime context retrieved/);
  assert.ok(result.structuredContent.runtimeContext);
});

test('handlePageTool state calls page.get_state', async () => {
  await withMockedBridge(
    async () =>
      ok({
        url: 'https://example.com/',
        title: 'Example',
        origin: 'https://example.com',
        hints: {},
      }),
    async (calls) => {
      const result = await handlePageTool({ action: 'state' });
      const pageCall = calls.find((c) => c.method === 'page.get_state');
      assert.ok(pageCall, 'page.get_state should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('default MCP routing does not fall back to configured remotes', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async (_record, index) => {
        if (index === 0) {
          return fail('ACCESS_DENIED', 'Browser Bridge is off for this window.');
        }
        return ok({
          url: 'https://private.example/current',
          title: 'Private',
          origin: 'https://private.example',
          hints: {},
        });
      },
      async (calls) => {
        const result = await handlePageTool({ action: 'state' });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'page.get_state');
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.ok, false);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('mutating input does not fall back to a configured remote', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async () => fail('ACCESS_DENIED', 'Browser Bridge is off for this window.'),
      async (calls) => {
        const result = await handleInputTool({ action: 'click', elementRef: 'el_1' });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'input.click');
        assert.equal(result.isError, true);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('mutating raw calls do not fall back to a configured remote', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async () => fail('ACCESS_DENIED', 'Browser Bridge is off for this window.'),
      async (calls) => {
        const result = await handleRawCallTool({
          method: 'navigation.navigate',
          params: { url: 'https://example.com' },
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'navigation.navigate');
        assert.equal(result.isError, true);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('explicit MCP destinations do not fall back to other remotes', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async () => fail('ACCESS_DENIED', 'Browser Bridge is off for this window.'),
      async (calls) => {
        const result = await handlePageTool({ action: 'state', destinationId: 'vm-private' });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'page.get_state');
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.ok, false);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('mutating input supports an explicit remote destination', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async () => ok({ clicked: true, elementRef: 'el_1' }),
      async (calls) => {
        const result = await handleInputTool({
          action: 'click',
          elementRef: 'el_1',
          destinationId: 'vm-private',
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'input.click');
        assert.equal(result.isError, undefined);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('handleLogTool targets a configured remote destination', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async () => ok({ entries: [] }),
      async (calls) => {
        const result = await handleLogTool({ destinationId: 'vm-private' });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'log.tail');
        assert.equal(result.isError, undefined);
        assert.equal(result.structuredContent.ok, true);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('handleLogTool reports unknown destinations without calling the bridge', async () => {
  await withBridgeHome(async () => {
    await withMockedBridge(
      async () => ok({ entries: [] }),
      async (calls) => {
        const result = await handleLogTool({ destinationId: 'missing' });

        assert.equal(calls.length, 0);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Unknown Browser Bridge destination/u);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('handlePageTool evaluate calls page.evaluate with given expression', async () => {
  await withMockedBridge(
    async () => ok({ value: 42, type: 'number' }),
    async (calls) => {
      const result = await handlePageTool({
        action: 'evaluate',
        expression: '1+1',
      });
      const evalCall = calls.find((c) => c.method === 'page.evaluate');
      assert.ok(evalCall, 'page.evaluate should be called');
      assert.ok(evalCall.params);
      assert.equal(evalCall.params.expression, '1+1');
      assert.equal(evalCall.meta?.source, 'mcp');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleNavigationTool navigate calls navigation.navigate', async () => {
  await withMockedBridge(
    async () => ok({ navigated: true }),
    async (calls) => {
      const result = await handleNavigationTool({
        action: 'navigate',
        url: 'https://example.com',
      });
      const navCall = calls.find((c) => c.method === 'navigation.navigate');
      assert.ok(navCall, 'navigation.navigate should be called');
      assert.ok(navCall.params);
      assert.equal(navCall.params.url, 'https://example.com');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleNavigationTool scroll calls viewport.scroll', async () => {
  await withMockedBridge(
    async () => ok({}),
    async (calls) => {
      const result = await handleNavigationTool({ action: 'scroll', top: 500 });
      const scrollCall = calls.find((c) => c.method === 'viewport.scroll');
      assert.ok(scrollCall, 'viewport.scroll should be called');
      assert.ok(scrollCall.params);
      assert.equal(scrollCall.params.top, 500);
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleInputTool click passes selectors atomically to input.click', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_btn',
              tag: 'button',
              attrs: {},
              bbox: {},
              textExcerpt: 'OK',
            },
          ],
        });
      }
      return ok({});
    },
    async (calls) => {
      const result = await handleInputTool({
        action: 'click',
        selector: 'button',
        modifiers: ['Meta'],
        executionMode: 'cdp',
        recoverStale: true,
      });
      const clickCall = calls.find((c) => c.method === 'input.click');
      assert.ok(clickCall, 'input.click should be called');
      assert.equal(calls.length, 1);
      assert.deepEqual(clickCall.params, {
        target: { selector: 'button' },
        button: undefined,
        clickCount: undefined,
        modifiers: ['Meta'],
        executionMode: 'cdp',
        recoverStale: true,
      });
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleStylesLayoutTool computed resolves ref and calls styles.get_computed', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_div',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({ properties: { color: 'red' }, elementRef: 'el_div' });
    },
    async (calls) => {
      const result = await handleStylesLayoutTool({
        action: 'computed',
        selector: 'div',
        properties: ['color'],
      });
      const styleCall = calls.find((c) => c.method === 'styles.get_computed');
      assert.ok(styleCall, 'styles.get_computed should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handlePatchTool list calls patch.list', async () => {
  await withMockedBridge(
    async () => ok({ patches: [] }),
    async (calls) => {
      const result = await handlePatchTool({ action: 'list' });
      const patchCall = calls.find((c) => c.method === 'patch.list');
      assert.ok(patchCall, 'patch.list should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleCaptureTool element resolves ref and calls screenshot.capture_element', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_hero',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({
        image: `data:image/png;base64,${ONE_PIXEL_PNG}`,
        rect: { x: 0, y: 0, width: 1, height: 1 },
      });
    },
    async (calls) => {
      const result = await handleCaptureTool({
        action: 'element',
        selector: '.hero',
      });
      const captureCall = calls.find((c) => c.method === 'screenshot.capture_element');
      assert.ok(captureCall, 'screenshot.capture_element should be called');
      assert.equal(result.isError, undefined);
      const image = result.content.find((block) => block.type === 'image');
      assert.ok(image && image.type === 'image');
      assert.equal(image.mimeType, 'image/png');
      assert.equal(image.data, ONE_PIXEL_PNG);
      assert.deepEqual(Buffer.from(image.data, 'base64').subarray(1, 4).toString('ascii'), 'PNG');
      assert.equal(
        result.structuredContent.byteLength,
        Buffer.from(ONE_PIXEL_PNG, 'base64').length
      );
      assert.equal(Object.hasOwn(result.structuredContent, 'image'), false);
    }
  );
});

test('grouped MCP tools accept explicit tabId and budget presets', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_main',
              tag: 'main',
              attrs: {},
              bbox: {},
              textExcerpt: 'Hello',
            },
          ],
        });
      }
      return ok({ value: 'Ready', truncated: false, length: 5 });
    },
    async (calls) => {
      const domResult = await handleDomTool({
        action: 'query',
        selector: 'main',
        tabId: 88,
        budgetPreset: 'quick',
      });

      await handlePageTool({
        action: 'text',
        tabId: 88,
        budgetPreset: 'deep',
      });

      const domCall = calls.find((call) => call.method === 'dom.query');
      const pageTextCall = calls.find((call) => call.method === 'page.get_text');
      assert.ok(domCall);
      assert.ok(domCall.params);
      assert.ok(domCall.meta);
      assert.equal(domCall.tabId, 88);
      assert.equal(domCall.params.maxNodes, 5);
      assert.equal(domCall.params.maxDepth, 2);
      assert.equal(domCall.params.textBudget, 300);
      assert.equal(domCall.meta.token_budget, 500);
      const deliveredTokens = Number(domResult.structuredContent.deliveredTokens);
      const summaryTokens = Number(domResult.structuredContent.summaryTokens);
      const transportTokens = Number(domResult.structuredContent.transportTokens);
      assert.ok(deliveredTokens > 0);
      assert.ok(summaryTokens > 0);
      assert.ok(transportTokens > 0);

      assert.ok(pageTextCall);
      assert.ok(pageTextCall.params);
      assert.ok(pageTextCall.meta);
      assert.equal(pageTextCall.tabId, 88);
      assert.equal(pageTextCall.params.textBudget, DEFAULT_PAGE_TEXT_BUDGET * 2);
      assert.ok(Number(pageTextCall.params.textBudget) > DEFAULT_PAGE_TEXT_BUDGET);
      assert.equal(pageTextCall.meta.token_budget, 4000);
    }
  );
});

test('handleBatchTool preserves order and reports mixed results with tab routing', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_main',
              tag: 'main',
              attrs: {},
              bbox: {},
              textExcerpt: 'Hello',
            },
          ],
        });
      }
      if (record.method === 'page.get_text') {
        return fail('TIMEOUT', 'Slow page text');
      }
      return ok({ daemon: 'ok', extensionConnected: true });
    },
    async (calls) => {
      const result = await handleBatchTool({
        calls: [
          { method: 'health.ping' },
          {
            method: 'dom.query',
            params: { selector: 'main' },
            budgetPreset: 'quick',
            tabId: 91,
          },
          { method: 'page.get_text', budgetPreset: 'normal' },
        ],
      });

      const batchResults = result.structuredContent.results as BatchResult[];
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.ok, false);
      assert.equal(batchResults.length, 3);
      assert.equal(batchResults[0].method, 'health.ping');
      assert.equal(batchResults[1].method, 'dom.query');
      assert.equal(batchResults[2].method, 'page.get_text');
      assert.equal(typeof batchResults[0].durationMs, 'number');
      assert.equal(typeof batchResults[0].approxTokens, 'number');
      assert.ok('meta' in batchResults[0]);

      const domCall = calls.find((call) => call.method === 'dom.query');
      const pageTextCall = calls.find((call) => call.method === 'page.get_text');
      assert.equal(domCall?.tabId, 91);
      assert.equal(domCall?.params?.maxNodes, 5);
      assert.equal(domCall?.params?.maxDepth, 2);
      assert.equal(domCall?.params?.textBudget, 300);
      assert.equal(pageTextCall?.tabId, null);
      assert.equal(pageTextCall?.params?.textBudget, DEFAULT_PAGE_TEXT_BUDGET);
    }
  );
});

test('handleBatchTool applies method presets while preserving explicit params', async () => {
  await withMockedBridge(
    async () => ok({ entries: [], nodes: [], text: '', truncated: false, length: 0 }),
    async (calls) => {
      await handleBatchTool({
        calls: [
          {
            method: 'dom.query',
            params: { selector: 'body', maxNodes: 7 },
            budgetPreset: 'deep',
          },
          { method: 'dom.get_text', params: { elementRef: 'el_1' }, budgetPreset: 'quick' },
          { method: 'dom.get_html', params: { elementRef: 'el_1' }, budgetPreset: 'deep' },
          { method: 'page.get_console', budgetPreset: 'quick' },
          { method: 'page.get_network', params: { limit: 3 }, budgetPreset: 'deep' },
          { method: 'log.tail', budgetPreset: 'normal' },
        ],
      });

      const byMethod = new Map(calls.map((call) => [call.method, call]));
      assert.deepEqual(byMethod.get('dom.query')?.params, {
        selector: 'body',
        maxNodes: 7,
        maxDepth: 8,
        textBudget: 2000,
      });
      assert.equal(byMethod.get('dom.get_text')?.params?.textBudget, 300);
      assert.equal(byMethod.get('dom.get_html')?.params?.maxLength, 6000);
      assert.equal(byMethod.get('page.get_console')?.params?.limit, 10);
      assert.equal(byMethod.get('page.get_network')?.params?.limit, 3);
      assert.equal(byMethod.get('log.tail')?.params?.limit, 20);
    }
  );
});

test('handleBatchTool isolates destination creation failures and preserves destination IDs', async () => {
  await withMockedBridge(
    async () => ok({ daemon: 'ok', extensionConnected: true }),
    async (calls) => {
      const result = await handleBatchTool({
        calls: [
          { method: 'health.ping', destinationId: 'missing-remote' },
          { method: 'health.ping' },
        ],
      });
      const results = result.structuredContent.results as Array<
        BatchResult & {
          destinationId: string | null;
        }
      >;

      assert.equal(calls.length, 1);
      assert.equal(results[0].destinationId, 'missing-remote');
      assert.equal(results[0].ok, false);
      assert.equal(results[1].destinationId, null);
      assert.equal(results[1].ok, true);
    }
  );
});

test('handleBatchTool runs remote calls when the local daemon connection fails', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    const originalConnect = BridgeClient.prototype.connect;
    const originalClose = BridgeClient.prototype.close;
    const originalRequest = BridgeClient.prototype.request;
    const requests: BridgeMethod[] = [];
    BridgeClient.prototype.connect = async function connect() {
      if (this.transport.type !== 'tcp' || this.transport.host !== '10.0.0.5') {
        const error = new Error('Local daemon unavailable') as Error & { code: string };
        error.code = 'NATIVE_HOST_UNAVAILABLE';
        throw error;
      }
      this.connected = true;
    };
    BridgeClient.prototype.close = async function close() {};
    BridgeClient.prototype.request = async function request({ method }): Promise<BridgeResponse> {
      requests.push(method);
      return ok({ daemon: 'ok', extensionConnected: true });
    };
    try {
      const result = await handleBatchTool({
        calls: [{ method: 'health.ping' }, { method: 'health.ping', destinationId: 'vm-private' }],
      });
      const results = result.structuredContent.results as Array<
        BatchResult & {
          destinationId: string | null;
          error?: { code: string };
        }
      >;
      assert.deepEqual(requests, ['health.ping']);
      assert.equal(results[0].destinationId, null);
      assert.equal(results[0].error?.code, 'NATIVE_HOST_UNAVAILABLE');
      assert.equal(results[1].destinationId, 'vm-private');
      assert.equal(results[1].ok, true);
    } finally {
      BridgeClient.prototype.connect = originalConnect;
      BridgeClient.prototype.close = originalClose;
      BridgeClient.prototype.request = originalRequest;
    }
  });
});

test('handleStatusTool reports remote reachability separately from route readiness', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async () =>
        ok({
          daemon: 'ok',
          extensionConnected: true,
          access: { enabled: true, routeReady: false, reason: 'no_routable_active_tab' },
        }),
      async () => {
        const result = await handleStatusTool({ destinationId: 'vm-private' });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.ok, false);
        assert.equal(result.structuredContent.reachable, true);
        assert.equal(result.structuredContent.daemonReachable, true);
        assert.equal(result.structuredContent.extensionConnected, true);
        assert.equal(result.structuredContent.routeReady, false);
        assert.match(result.content[0].text, /reachable, but its browser route is not ready/);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('handleStatusTool reports a ready explicit remote destination', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async () =>
        ok({
          daemon: 'ok',
          extensionConnected: true,
          access: { enabled: true, routeReady: true, routeTabId: 44 },
        }),
      async () => {
        const result = await handleStatusTool({ destinationId: 'vm-private' });
        assert.equal(result.isError, undefined);
        assert.equal(result.structuredContent.ok, true);
        assert.equal(result.structuredContent.reachable, true);
        assert.equal(result.structuredContent.accessEnabled, true);
        assert.equal(result.structuredContent.routeReady, true);
        assert.equal(result.structuredContent.routeTabId, 44);
        assert.match(result.content[0].text, /destination "vm-private" is ready/);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('handleStatusTool reports an unreachable explicit remote destination', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async () => fail('NATIVE_HOST_UNAVAILABLE', 'Remote daemon unavailable'),
      async () => {
        const result = await handleStatusTool({ destinationId: 'vm-private' });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.ok, false);
        assert.equal(result.structuredContent.reachable, false);
        assert.equal(result.structuredContent.extensionConnected, false);
        assert.equal(result.structuredContent.accessEnabled, false);
        assert.equal(result.structuredContent.routeReady, false);
        assert.equal(result.structuredContent.routeTabId, null);
        assert.match(result.content[0].text, /destination "vm-private" is not reachable/);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('handleSkillTool routes runtime context to an explicit destination', async () => {
  await withBridgeHome(async (bridgeHome) => {
    await writeRemoteConfig(bridgeHome);
    await withMockedBridge(
      async () => ok({ budgetPresets: {}, methodGroups: {}, limits: {} }),
      async (calls) => {
        const result = await handleSkillTool({ destinationId: 'vm-private' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'skill.get_runtime_context');
        assert.equal(result.structuredContent.ok, true);
      },
      { isolateBridgeHome: false }
    );
  });
});

test('selector resolution preserves bridge error code and details', async () => {
  await withMockedBridge(
    async () => fail('ELEMENT_STALE', 'Selector registry is stale', { details: { ref: 'el_old' } }),
    async () => {
      const result = await handleStylesLayoutTool({ action: 'computed', selector: '.target' });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent.error, {
        code: 'ELEMENT_STALE',
        message: 'Selector registry is stale',
        details: { ref: 'el_old' },
      });
      assert.deepEqual(result.structuredContent.evidence, { ref: 'el_old' });
    }
  );
});

test('MCP descriptions stay aligned with protocol defaults', () => {
  assert.match(BUDGET_PRESET_DESCRIPTION, /quick/);
  assert.match(BUDGET_PRESET_DESCRIPTION, /normal/);
  assert.match(BUDGET_PRESET_DESCRIPTION, new RegExp(String(BUDGET_PRESETS.normal.maxNodes)));
  assert.match(BUDGET_PRESET_DESCRIPTION, new RegExp(String(BUDGET_PRESETS.normal.textBudget)));
  assert.equal(DEFAULT_PAGE_TEXT_BUDGET, 8000);
});

test('grouped MCP tool action maps stay aligned with the bridge method registry', () => {
  const actionCollections = [
    DOM_ACTIONS,
    STYLES_LAYOUT_ACTIONS,
    PAGE_ACTIONS,
    NAVIGATION_ACTIONS,
    PATCH_ACTIONS,
    CAPTURE_ACTIONS,
  ];

  for (const collection of actionCollections) {
    for (const entry of Object.values(collection)) {
      assert.ok(
        BRIDGE_METHOD_REGISTRY[entry.method],
        `${entry.method} should exist in the bridge registry`
      );
    }
  }

  for (const method of Object.values(INPUT_ACTION_METHODS)) {
    assert.ok(BRIDGE_METHOD_REGISTRY[method], `${method} should exist in the bridge registry`);
  }
});

// ---------------------------------------------------------------------------
// browser_investigate
// ---------------------------------------------------------------------------

test('handleInvestigateTool normal scope runs page.get_state, dom.query, page.get_text and reports allOk when every step succeeds', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'page.get_state')
        return ok({
          url: 'https://example.com/',
          title: 'Example',
          origin: 'https://example.com',
          readyState: 'complete',
          hints: {},
        });
      if (record.method === 'dom.query')
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: 'Hello',
            },
          ],
        });
      if (record.method === 'page.get_text')
        return ok({ text: 'Hello world', truncated: false, length: 11 });
      return ok({});
    },
    async (calls) => {
      const result = await handleInvestigateTool({
        objective: 'Find the main heading',
      });
      assert.equal(calls.length, 3);
      assert.equal(calls[0].method, 'page.get_state');
      assert.equal(calls[1].method, 'dom.query');
      assert.equal(calls[2].method, 'page.get_text');
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.ok, true);
      assert.equal(result.structuredContent.heuristicFallback, true);
      assert.equal((result.structuredContent.steps as unknown[]).length, 3);
      assert.deepEqual(
        (result.structuredContent.steps as InvestigationStep[]).map((step) => ({
          method: step.method,
          ok: step.ok,
        })),
        [
          { method: 'page.get_state', ok: true },
          { method: 'dom.query', ok: true },
          { method: 'page.get_text', ok: true },
        ]
      );
      assert.match(result.content[0].text, /Investigation complete/);
    }
  );
});

test('handleInvestigateTool quick scope runs only page.get_state and dom.query', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'page.get_state')
        return ok({
          url: 'https://example.com/',
          title: 'Ex',
          origin: 'https://example.com',
          readyState: 'complete',
          hints: {},
        });
      if (record.method === 'dom.query')
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'body',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      return ok({});
    },
    async (calls) => {
      const result = await handleInvestigateTool({
        objective: 'Check page',
        scope: 'quick',
      });
      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, 'page.get_state');
      assert.equal(calls[1].method, 'dom.query');
      assert.equal(result.structuredContent.scope, 'quick');
    }
  );
});

test('handleInvestigateTool deep scope runs the documented five-step sequence', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'page.get_state') {
        return ok({
          url: 'https://example.com/',
          title: 'Example',
          origin: 'https://example.com',
          readyState: 'complete',
          hints: {},
        });
      }
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'main',
              attrs: {},
              bbox: {},
              textExcerpt: 'Main content',
            },
          ],
        });
      }
      if (record.method === 'page.get_text') {
        return ok({ text: 'Full page text', truncated: false, length: 14 });
      }
      if (record.method === 'page.get_console') {
        return ok({
          entries: [{ level: 'warn', args: ['Heads up'], ts: Date.now() }],
          count: 1,
          total: 1,
        });
      }
      if (record.method === 'page.get_network') {
        return ok({
          entries: [
            {
              type: 'fetch',
              method: 'GET',
              url: 'https://example.com/api/items',
              status: 200,
              duration: 42,
            },
          ],
          count: 1,
          total: 1,
        });
      }
      return ok({});
    },
    async (calls) => {
      const result = await handleInvestigateTool({
        objective: 'Inspect page deeply',
        scope: 'deep',
      });

      assert.equal(calls.length, 5);
      assert.deepEqual(
        calls.map((call) => call.method),
        ['page.get_state', 'dom.query', 'page.get_text', 'page.get_console', 'page.get_network']
      );
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.ok, true);
      assert.equal(result.structuredContent.scope, 'deep');
      assert.equal((result.structuredContent.steps as unknown[]).length, 5);
    }
  );
});

test('handleInvestigateTool rejects missing objective', async () => {
  const result = await handleInvestigateTool({ objective: '' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /objective is required/);
});

test('handleInvestigateTool rejects unknown scope', async () => {
  const result = await handleInvestigateTool({
    objective: 'Inspect page',
    scope: 'bogus' as unknown as 'quick',
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unsupported investigation scope "bogus"/);
});

test('handleInvestigateTool continues after individual step failure', async () => {
  let callCount = 0;
  await withMockedBridge(
    async () => {
      callCount++;
      if (callCount === 2) return fail('ACCESS_DENIED', 'Denied');
      return ok({
        url: 'https://example.com/',
        title: 'Ex',
        origin: 'https://example.com',
        readyState: 'complete',
        hints: {},
      });
    },
    async (calls) => {
      const result = await handleInvestigateTool({
        objective: 'Test failure',
        scope: 'normal',
      });
      assert.equal(calls.length, 3); // all 3 steps attempted (ACCESS_DENIED is not retriable)
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.ok, false);
      assert.match(result.content[0].text, /partial/);
    }
  );
});

test('handleInvestigateTool aggregates thrown step failures into failedSteps', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'page.get_state') {
        return ok({
          url: 'https://example.com/',
          title: 'Example',
          origin: 'https://example.com',
          readyState: 'complete',
          hints: {},
        });
      }
      if (record.method === 'dom.query') {
        throw new Error('DOM query exploded');
      }
      if (record.method === 'page.get_text') {
        return ok({ text: 'Hello world', truncated: false, length: 11 });
      }
      return ok({});
    },
    async (calls) => {
      const result = await handleInvestigateTool({
        objective: 'Check the page body',
        scope: 'normal',
      });

      assert.deepEqual(
        calls.map((call) => call.method),
        ['page.get_state', 'dom.query', 'page.get_text']
      );
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.ok, false);
      assert.equal(result.structuredContent.scope, 'normal');
      assert.equal((result.structuredContent.steps as unknown[]).length, 3);
      const failedSteps = result.structuredContent.failedSteps as InvestigationStep[];
      assert.equal(failedSteps.length, 1);
      assert.equal(failedSteps[0].method, 'dom.query');
      assert.equal(failedSteps[0].ok, false);
      assert.equal(failedSteps[0].summary, 'ERROR: DOM query exploded');
      assert.equal(failedSteps[0].evidence, null);
      assert.equal(typeof failedSteps[0].durationMs, 'number');
      assert.match(result.content[0].text, /1 failed/);
    }
  );
});

test('handleInvestigateTool forwards tabId to bridge calls', async () => {
  await withMockedBridge(
    async () =>
      ok({
        url: 'https://example.com/',
        title: 'Ex',
        origin: 'https://example.com',
        readyState: 'complete',
        hints: {},
      }),
    async (calls) => {
      await handleInvestigateTool({
        objective: 'Check tab',
        scope: 'quick',
        tabId: 42,
      });
      assert.equal(calls[0].tabId, 42);
      assert.equal(calls[1].tabId, 42);
    }
  );
});

test('handleInvestigateTool passes selector to dom.query', async () => {
  await withMockedBridge(
    async () =>
      ok({
        url: 'https://example.com/',
        title: 'Ex',
        origin: 'https://example.com',
        readyState: 'complete',
        hints: {},
      }),
    async (calls) => {
      await handleInvestigateTool({
        objective: 'Inspect nav',
        scope: 'quick',
        selector: 'nav.main',
      });
      assert.equal(calls[1].params?.selector, 'nav.main');
    }
  );
});
