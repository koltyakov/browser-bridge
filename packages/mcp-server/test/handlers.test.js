// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

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
} from '../../../tests/_helpers/protocolFactories.js';

/**
 * @typedef {{
 *   method: import('../../protocol/src/types.js').BridgeMethod,
 *   params?: Record<string, unknown>,
 *   tabId?: number | null,
 *   meta?: Record<string, unknown>
 * }} RequestRecord
 */

/**
 * @param {(record: RequestRecord, index: number) => Promise<import('../../protocol/src/types.js').BridgeResponse>} responder
 * @param {(calls: RequestRecord[]) => Promise<void>} callback
 * @returns {Promise<void>}
 */
async function withMockedBridge(responder, callback) {
  const originalConnect = BridgeClient.prototype.connect;
  const originalClose = BridgeClient.prototype.close;
  const originalRequest = BridgeClient.prototype.request;
  /** @type {RequestRecord[]} */
  const calls = [];

  BridgeClient.prototype.connect = async function connect() {
    this.connected = true;
  };
  BridgeClient.prototype.close = async function close() {};
  BridgeClient.prototype.request = async function request(
    /** @type {{ method: import('../../protocol/src/types.js').BridgeMethod, params?: Record<string, unknown>, tabId?: number | null, meta?: Record<string, unknown> }} */ {
      method,
      params = {},
      tabId = null,
      meta = {},
    }
  ) {
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

test('handleStatusTool returns doctor report without bridge calls', async () => {
  // handleStatusTool calls getDoctorReport, which tries to connect. Since there is no
  // daemon running in tests it should catch the error and still return a tool result.
  const result = await handleStatusTool();
  // Either success or error - the key is it must return a ToolResult, never throw.
  assert.ok(typeof result.structuredContent === 'object');
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /readiness issue|Browser Bridge is ready/);
  assert.doesNotMatch(result.content[0].text, /setup issue/);
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

test('handleSkillTool and handleSetupTool stay stable across repeated calls', async () => {
  const iterations = 20;
  const results = await Promise.all(
    Array.from({ length: iterations }, async () => {
      const [skillResult, setupResult] = await Promise.all([
        handleSkillTool(),
        handleSetupTool({ global: true }),
      ]);
      return { skillResult, setupResult };
    })
  );

  assert.equal(results.length, iterations);
  for (const { skillResult, setupResult } of results) {
    assert.equal(skillResult.isError, undefined);
    assert.match(skillResult.content[0].text, /Runtime context retrieved/);
    assert.ok(skillResult.structuredContent.runtimeContext);

    assert.equal(setupResult.isError, undefined);
    assert.match(setupResult.content[0].text, /Optional agent integration status:/);
    assert.equal(setupResult.structuredContent.ok, true);
    assert.ok(setupResult.structuredContent.status);
  }
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

test('handleInputTool click resolves elementRef and calls input.click', async () => {
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
      });
      const clickCall = calls.find((c) => c.method === 'input.click');
      assert.ok(clickCall, 'input.click should be called');
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
      return ok({ image: 'data:image/png;base64,abc', rect: {} });
    },
    async (calls) => {
      const result = await handleCaptureTool({
        action: 'element',
        selector: '.hero',
      });
      const captureCall = calls.find((c) => c.method === 'screenshot.capture_element');
      assert.ok(captureCall, 'screenshot.capture_element should be called');
      assert.equal(result.isError, undefined);
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
      assert.equal(pageTextCall.params.textBudget, 2000);
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

      const batchResults =
        /** @type {Array<{ method: string }>} */ (result.structuredContent.results);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.ok, false);
      assert.equal(batchResults.length, 3);
      assert.equal(batchResults[0].method, 'health.ping');
      assert.equal(batchResults[1].method, 'dom.query');
      assert.equal(batchResults[2].method, 'page.get_text');
      assert.equal(typeof (/** @type {any} */ (batchResults[0]).durationMs), 'number');
      assert.equal(typeof (/** @type {any} */ (batchResults[0]).approxTokens), 'number');
      assert.ok('meta' in /** @type {any} */ (batchResults[0]));

      const domCall = calls.find((call) => call.method === 'dom.query');
      const pageTextCall = calls.find((call) => call.method === 'page.get_text');
      assert.equal(domCall?.tabId, 91);
      assert.equal(pageTextCall?.tabId, null);
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
      assert.equal(/** @type {unknown[]} */ (result.structuredContent.steps).length, 3);
      assert.deepEqual(
        /** @type {Array<{ method: string, ok: boolean }>} */ (result.structuredContent.steps).map(
          (step) => ({ method: step.method, ok: step.ok })
        ),
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
      assert.equal(/** @type {unknown[]} */ (result.structuredContent.steps).length, 5);
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
    scope: /** @type {any} */ ('bogus'),
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
      assert.equal(/** @type {unknown[]} */ (result.structuredContent.steps).length, 3);
      const failedSteps =
        /** @type {Array<{ method: string, ok: boolean, summary: string, evidence: unknown, durationMs: number }>} */ (
          result.structuredContent.failedSteps
        );
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
