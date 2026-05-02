// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { BridgeClient } from '../../agent-client/src/client.js';
import {
  handleCaptureTool,
  handleDomTool,
  handleInputTool,
  handleNavigationTool,
  handlePageTool,
  handlePatchTool,
  handleStylesLayoutTool,
  handleBatchTool,
  handleRawCallTool,
  handleLogTool,
  handleAccessTool,
} from '../src/handlers.js';

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

/** @param {unknown} result */
function ok(result) {
  return /** @type {import('../../protocol/src/types.js').BridgeResponse} */ ({
    id: 'req_test',
    ok: true,
    result,
    error: null,
    meta: { protocol_version: '1.0' },
  });
}

/** @param {string} code @param {string} message */
function fail(code, message) {
  return /** @type {import('../../protocol/src/types.js').BridgeResponse} */ ({
    id: 'req_test',
    ok: false,
    result: null,
    error: { code: /** @type {any} */ (code), message, details: null },
    meta: { protocol_version: '1.0' },
  });
}

// --- handleTabsTool: close action ---

test('handleTabsTool close requires tabId', async () => {
  const { handleTabsTool } = await import('../src/handlers.js');
  await withMockedBridge(
    async () => ok({}),
    async (calls) => {
      const result = await handleTabsTool({ action: 'close' });
      assert.equal(calls.length, 0);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /tabId is required/);
    }
  );
});

test('handleTabsTool close calls tabs.close with tabId', async () => {
  const { handleTabsTool } = await import('../src/handlers.js');
  await withMockedBridge(
    async () => ok({ closed: true, tabId: 5 }),
    async (calls) => {
      const result = await handleTabsTool({ action: 'close', tabId: 5 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'tabs.close');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleTabsTool returns error for unsupported action', async () => {
  const { handleTabsTool } = await import('../src/handlers.js');
  await withMockedBridge(
    async () => ok({}),
    async (calls) => {
      const result = await handleTabsTool({ action: 'bogus' });
      assert.equal(calls.length, 0);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unsupported/);
    }
  );
});

// --- handleDomTool: additional actions ---

test('handleDomTool text calls dom.get_text with textBudget', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'p',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({ value: 'Hello world', truncated: false, length: 11 });
    },
    async (calls) => {
      const result = await handleDomTool({
        action: 'text',
        selector: 'p',
        budgetPreset: 'quick',
      });
      const textCall = calls.find((c) => c.method === 'dom.get_text');
      assert.ok(textCall, 'dom.get_text should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleDomTool html calls dom.get_html', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({ html: '<div>hi</div>', truncated: false });
    },
    async (calls) => {
      const result = await handleDomTool({
        action: 'html',
        selector: 'div',
        budgetPreset: 'normal',
      });
      const htmlCall = calls.find((c) => c.method === 'dom.get_html');
      assert.ok(htmlCall, 'dom.get_html should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleDomTool describe calls dom.describe', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({
        tag: 'div',
        elementRef: 'el_1',
        bbox: { width: 100, height: 50 },
      });
    },
    async (calls) => {
      const result = await handleDomTool({
        action: 'describe',
        selector: 'div',
      });
      const describeCall = calls.find((c) => c.method === 'dom.describe');
      assert.ok(describeCall, 'dom.describe should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleDomTool wait calls dom.wait_for', async () => {
  await withMockedBridge(
    async () => ok({ found: true, duration: 100, elementRef: 'el_1' }),
    async (calls) => {
      const result = await handleDomTool({
        action: 'wait',
        selector: '.loading',
        state: 'visible',
      });
      const waitCall = calls.find((c) => c.method === 'dom.wait_for');
      assert.ok(waitCall, 'dom.wait_for should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleDomTool find_text calls dom.find_by_text', async () => {
  await withMockedBridge(
    async () =>
      ok({
        nodes: [
          {
            elementRef: 'el_1',
            tag: 'span',
            attrs: {},
            bbox: {},
            textExcerpt: 'target',
          },
        ],
      }),
    async (calls) => {
      const result = await handleDomTool({
        action: 'find_text',
        text: 'target',
      });
      const findCall = calls.find((c) => c.method === 'dom.find_by_text');
      assert.ok(findCall, 'dom.find_by_text should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleDomTool find_role calls dom.find_by_role', async () => {
  await withMockedBridge(
    async () =>
      ok({
        nodes: [
          {
            elementRef: 'el_1',
            tag: 'button',
            attrs: {},
            bbox: {},
            textExcerpt: 'OK',
          },
        ],
      }),
    async (calls) => {
      const result = await handleDomTool({
        action: 'find_role',
        role: 'button',
      });
      const findCall = calls.find((c) => c.method === 'dom.find_by_role');
      assert.ok(findCall, 'dom.find_by_role should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleDomTool returns error for unsupported action', async () => {
  await withMockedBridge(
    async () => ok({}),
    async () => {
      const result = await handleDomTool({ action: 'nonexistent' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unsupported DOM action/);
    }
  );
});

test('handleDomTool query infers quick budget for ID selectors', async () => {
  await withMockedBridge(
    async () =>
      ok({
        nodes: [
          {
            elementRef: 'el_1',
            tag: 'div',
            attrs: {},
            bbox: {},
            textExcerpt: '',
          },
        ],
      }),
    async (calls) => {
      await handleDomTool({ action: 'query', selector: '#main' });
      assert.ok(calls[0].params);
      assert.equal(calls[0].params.maxNodes, 5);
    }
  );
});

test('handleDomTool query infers deep budget for nested selectors', async () => {
  await withMockedBridge(
    async () =>
      ok({
        nodes: [
          {
            elementRef: 'el_1',
            tag: 'div',
            attrs: {},
            bbox: {},
            textExcerpt: '',
          },
        ],
      }),
    async (calls) => {
      await handleDomTool({ action: 'query', selector: 'div ul li a span' });
      assert.ok(calls[0].params);
      assert.equal(calls[0].params.textBudget, 2000);
    }
  );
});

// --- handlePageTool: additional actions ---

test('handlePageTool console calls page.get_console with budget preset', async () => {
  await withMockedBridge(
    async () =>
      ok({
        entries: [{ level: 'error', args: ['fail'], ts: Date.now() }],
        count: 1,
        total: 1,
      }),
    async (calls) => {
      const result = await handlePageTool({
        action: 'console',
        budgetPreset: 'quick',
      });
      const consoleCall = calls.find((c) => c.method === 'page.get_console');
      assert.ok(consoleCall, 'page.get_console should be called');
      assert.ok(consoleCall.params);
      assert.equal(consoleCall.params.limit, 10);
      assert.equal(result.isError, undefined);
    }
  );
});

test('handlePageTool network calls page.get_network with budget preset', async () => {
  await withMockedBridge(
    async () =>
      ok({
        entries: [],
        count: 0,
        total: 0,
      }),
    async (calls) => {
      const result = await handlePageTool({
        action: 'network',
        budgetPreset: 'deep',
      });
      const netCall = calls.find((c) => c.method === 'page.get_network');
      assert.ok(netCall, 'page.get_network should be called');
      assert.ok(netCall.params);
      assert.equal(netCall.params.limit, 100);
      assert.equal(result.isError, undefined);
    }
  );
});

test('handlePageTool storage calls page.get_storage', async () => {
  await withMockedBridge(
    async () =>
      ok({
        count: 2,
        type: 'localStorage',
        entries: { a: '1', b: '2' },
      }),
    async (calls) => {
      const result = await handlePageTool({
        action: 'storage',
        type: 'localStorage',
      });
      const storageCall = calls.find((c) => c.method === 'page.get_storage');
      assert.ok(storageCall, 'page.get_storage should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handlePageTool wait_for_load calls page.wait_for_load_state', async () => {
  await withMockedBridge(
    async () => ok({}),
    async (calls) => {
      const result = await handlePageTool({
        action: 'wait_for_load',
        timeoutMs: 5000,
      });
      const waitCall = calls.find((c) => c.method === 'page.wait_for_load_state');
      assert.ok(waitCall, 'page.wait_for_load_state should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handlePageTool performance calls performance.get_metrics', async () => {
  await withMockedBridge(
    async () => ok({ metrics: { FCP: 1200 } }),
    async (calls) => {
      const result = await handlePageTool({ action: 'performance' });
      const perfCall = calls.find((c) => c.method === 'performance.get_metrics');
      assert.ok(perfCall, 'performance.get_metrics should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handlePageTool returns error for unsupported action', async () => {
  await withMockedBridge(
    async () => ok({}),
    async () => {
      const result = await handlePageTool({ action: 'nonexistent' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unsupported page action/);
    }
  );
});

// --- handleNavigationTool: additional actions ---

test('handleNavigationTool reload calls navigation.reload', async () => {
  await withMockedBridge(
    async () => ok({}),
    async (calls) => {
      const result = await handleNavigationTool({ action: 'reload' });
      assert.equal(calls[0].method, 'navigation.reload');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleNavigationTool go_back calls navigation.go_back', async () => {
  await withMockedBridge(
    async () => ok({}),
    async (calls) => {
      const result = await handleNavigationTool({ action: 'go_back' });
      assert.equal(calls[0].method, 'navigation.go_back');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleNavigationTool go_forward calls navigation.go_forward', async () => {
  await withMockedBridge(
    async () => ok({}),
    async (calls) => {
      const result = await handleNavigationTool({ action: 'go_forward' });
      assert.equal(calls[0].method, 'navigation.go_forward');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleNavigationTool resize calls viewport.resize', async () => {
  await withMockedBridge(
    async () => ok({ resized: true, width: 800, height: 600 }),
    async (calls) => {
      const result = await handleNavigationTool({
        action: 'resize',
        width: 800,
        height: 600,
      });
      assert.equal(calls[0].method, 'viewport.resize');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleNavigationTool returns error for unsupported action', async () => {
  await withMockedBridge(
    async () => ok({}),
    async () => {
      const result = await handleNavigationTool({ action: 'bogus' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unsupported navigation action/);
    }
  );
});

// --- handleInputTool: additional actions ---

test('handleInputTool type calls input.type', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_input',
              tag: 'input',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({ typed: true, elementRef: 'el_input' });
    },
    async (calls) => {
      const result = await handleInputTool({
        action: 'type',
        selector: 'input',
        text: 'hello',
        clear: true,
      });
      const typeCall = calls.find((c) => c.method === 'input.type');
      assert.ok(typeCall, 'input.type should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleInputTool focus calls input.focus', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_input',
              tag: 'input',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({ focused: true, elementRef: 'el_input' });
    },
    async (calls) => {
      const result = await handleInputTool({
        action: 'focus',
        selector: 'input',
      });
      const focusCall = calls.find((c) => c.method === 'input.focus');
      assert.ok(focusCall, 'input.focus should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleInputTool press_key calls input.press_key without ref when no selector', async () => {
  await withMockedBridge(
    async () => ok({ pressed: true, key: 'Enter' }),
    async (calls) => {
      const result = await handleInputTool({
        action: 'press_key',
        key: 'Enter',
      });
      const pressCall = calls.find((c) => c.method === 'input.press_key');
      assert.ok(pressCall, 'input.press_key should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleInputTool cdp_press_key calls cdp.dispatch_key_event with explicit tab', async () => {
  await withMockedBridge(
    async () => ok({ dispatched: ['keyDown', 'keyUp'], key: 'Escape' }),
    async (calls) => {
      const result = await handleInputTool({
        action: 'cdp_press_key',
        key: 'Escape',
        tabId: 17,
      });
      const pressCall = calls.find((c) => c.method === 'cdp.dispatch_key_event');
      assert.ok(pressCall, 'cdp.dispatch_key_event should be called');
      assert.equal(pressCall.tabId, 17);
      assert.deepEqual(pressCall.params, {
        key: 'Escape',
        code: undefined,
        modifiers: undefined,
      });
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleInputTool hover calls input.hover', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({ hovered: true, elementRef: 'el_1' });
    },
    async (calls) => {
      const result = await handleInputTool({
        action: 'hover',
        selector: 'div',
      });
      const hoverCall = calls.find((c) => c.method === 'input.hover');
      assert.ok(hoverCall, 'input.hover should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleInputTool set_checked calls input.set_checked', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_cb',
              tag: 'input',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({});
    },
    async (calls) => {
      const result = await handleInputTool({
        action: 'set_checked',
        selector: 'input[type=checkbox]',
        checked: true,
      });
      const checkCall = calls.find((c) => c.method === 'input.set_checked');
      assert.ok(checkCall, 'input.set_checked should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleInputTool select_option calls input.select_option', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_sel',
              tag: 'select',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({});
    },
    async (calls) => {
      const result = await handleInputTool({
        action: 'select_option',
        selector: 'select',
        values: ['opt1'],
      });
      const selectCall = calls.find((c) => c.method === 'input.select_option');
      assert.ok(selectCall, 'input.select_option should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleInputTool drag calls input.drag with source and destination', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_src',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({
        dragged: true,
        sourceRef: 'el_src',
        destinationRef: 'el_dst',
      });
    },
    async (calls) => {
      const result = await handleInputTool({
        action: 'drag',
        sourceElementRef: 'el_src',
        destinationElementRef: 'el_dst',
      });
      const dragCall = calls.find((c) => c.method === 'input.drag');
      assert.ok(dragCall, 'input.drag should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleInputTool drag returns error when missing source or destination', async () => {
  await withMockedBridge(
    async () => ok({}),
    async () => {
      const result = await handleInputTool({ action: 'drag' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /sourceElementRef/);
    }
  );
});

test('handleInputTool scroll_into_view calls input.scroll_into_view', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({ scrolled: true });
    },
    async (calls) => {
      const result = await handleInputTool({
        action: 'scroll_into_view',
        selector: 'div',
      });
      const scrollCall = calls.find((c) => c.method === 'input.scroll_into_view');
      assert.ok(scrollCall, 'input.scroll_into_view should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleInputTool returns error for unsupported action', async () => {
  await withMockedBridge(
    async () => ok({}),
    async () => {
      const result = await handleInputTool({ action: 'nonexistent' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unsupported input action/);
    }
  );
});

// --- handlePatchTool: additional actions ---

test('handlePatchTool apply_styles calls patch.apply_styles', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({ patchId: 'p_1' });
    },
    async (calls) => {
      const result = await handlePatchTool({
        action: 'apply_styles',
        selector: 'div',
        declarations: { color: 'red' },
      });
      const patchCall = calls.find((c) => c.method === 'patch.apply_styles');
      assert.ok(patchCall, 'patch.apply_styles should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handlePatchTool rollback calls patch.rollback', async () => {
  await withMockedBridge(
    async () => ok({ rolledBack: true }),
    async (calls) => {
      const result = await handlePatchTool({
        action: 'rollback',
        patchId: 'p_1',
      });
      assert.equal(calls[0].method, 'patch.rollback');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handlePatchTool apply_dom calls patch.apply_dom', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({ patchId: 'p_2' });
    },
    async (calls) => {
      const result = await handlePatchTool({
        action: 'apply_dom',
        selector: 'div',
        operation: 'setAttribute',
        name: 'class',
        value: 'new-class',
      });
      const patchCall = calls.find((c) => c.method === 'patch.apply_dom');
      assert.ok(patchCall, 'patch.apply_dom should be called');
      assert.ok(patchCall.params);
      assert.equal(patchCall.params.operation, 'set_attribute');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handlePatchTool commit_baseline calls patch.commit_session_baseline', async () => {
  await withMockedBridge(
    async () => ok({}),
    async (calls) => {
      const result = await handlePatchTool({ action: 'commit_baseline' });
      assert.equal(calls[0].method, 'patch.commit_session_baseline');
      assert.equal(result.isError, undefined);
    }
  );
});

// --- handleStylesLayoutTool: additional actions ---

test('handleStylesLayoutTool matched_rules calls styles.get_matched_rules', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({});
    },
    async (calls) => {
      const result = await handleStylesLayoutTool({
        action: 'matched_rules',
        selector: 'div',
      });
      const rulesCall = calls.find((c) => c.method === 'styles.get_matched_rules');
      assert.ok(rulesCall, 'styles.get_matched_rules should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleStylesLayoutTool box_model calls layout.get_box_model', async () => {
  await withMockedBridge(
    async (record) => {
      if (record.method === 'dom.query') {
        return ok({
          nodes: [
            {
              elementRef: 'el_1',
              tag: 'div',
              attrs: {},
              bbox: {},
              textExcerpt: '',
            },
          ],
        });
      }
      return ok({
        content: { x: 0, y: 0, width: 100, height: 50 },
        border: {},
      });
    },
    async (calls) => {
      const result = await handleStylesLayoutTool({
        action: 'box_model',
        selector: 'div',
      });
      const boxCall = calls.find((c) => c.method === 'layout.get_box_model');
      assert.ok(boxCall, 'layout.get_box_model should be called');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleStylesLayoutTool hit_test calls layout.hit_test', async () => {
  await withMockedBridge(
    async () => ok({ x: 100, y: 200, width: 50, height: 30 }),
    async (calls) => {
      const result = await handleStylesLayoutTool({
        action: 'hit_test',
        x: 100,
        y: 200,
      });
      assert.equal(calls[0].method, 'layout.hit_test');
      assert.equal(result.isError, undefined);
    }
  );
});

// --- handleCaptureTool: additional actions ---

test('handleCaptureTool region calls screenshot.capture_region', async () => {
  await withMockedBridge(
    async () => ok({ image: 'data:image/png;base64,abc', rect: {} }),
    async (calls) => {
      const result = await handleCaptureTool({
        action: 'region',
        rect: { x: 0, y: 0, width: 100, height: 100 },
      });
      assert.equal(calls[0].method, 'screenshot.capture_region');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleCaptureTool full_page calls screenshot.capture_full_page', async () => {
  await withMockedBridge(
    async () => ok({ image: 'data:image/png;base64,abc' }),
    async (calls) => {
      const result = await handleCaptureTool({ action: 'full_page' });
      assert.equal(calls[0].method, 'screenshot.capture_full_page');
      assert.equal(result.isError, undefined);
    }
  );
});

test('handleCaptureTool cdp_document calls cdp.get_document', async () => {
  await withMockedBridge(
    async () => ok({}),
    async (calls) => {
      const result = await handleCaptureTool({ action: 'cdp_document' });
      assert.equal(calls[0].method, 'cdp.get_document');
      assert.equal(result.isError, undefined);
    }
  );
});

// --- handleBatchTool edge cases ---

test('handleBatchTool returns error for empty calls array', async () => {
  await withMockedBridge(
    async () => ok({}),
    async () => {
      const result = await handleBatchTool({ calls: [] });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /non-empty array/);
    }
  );
});

test('handleBatchTool returns error for missing calls', async () => {
  await withMockedBridge(
    async () => ok({}),
    async () => {
      const result = await handleBatchTool({});
      assert.equal(result.isError, true);
    }
  );
});

test('handleBatchTool handles invalid call entries', async () => {
  await withMockedBridge(
    async () => ok({}),
    async () => {
      const result = await handleBatchTool({
        calls: [
          /** @type {any} */ ({
            /* missing method */
          }),
          { method: 'not.real.method', params: {} },
          { method: 'health.ping', params: {} },
        ],
      });
      const results = /** @type {any[]} */ (result.structuredContent.results);
      assert.equal(results.length, 3);
      assert.equal(results[0].ok, false);
      assert.match(results[0].summary, /needs a method/);
      assert.equal(results[1].ok, false);
      assert.match(results[1].summary, /Unknown bridge method/);
    }
  );
});

// --- handleLogTool ---

test('handleLogTool calls log.tail with budget preset', async () => {
  await withMockedBridge(
    async () =>
      ok({
        entries: [{ at: '2024-01-01T00:00:00Z', method: 'dom.query', ok: true }],
      }),
    async (calls) => {
      const result = await handleLogTool({ budgetPreset: 'quick' });
      assert.equal(calls[0].method, 'log.tail');
      assert.ok(calls[0].params);
      assert.equal(calls[0].params.limit, 10);
      assert.equal(result.isError, undefined);
    }
  );
});

// --- handleRawCallTool: success case ---

test('handleRawCallTool calls bridge method and returns result on success', async () => {
  await withMockedBridge(
    async () => ok({ nodes: [] }),
    async (calls) => {
      const result = await handleRawCallTool({
        method: 'dom.query',
        params: { selector: 'body' },
      });
      assert.equal(calls[0].method, 'dom.query');
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /Called dom.query/);
    }
  );
});

test('handleRawCallTool returns error for bridge failure', async () => {
  await withMockedBridge(
    async () => fail('ACCESS_DENIED', 'Denied'),
    async () => {
      const result = await handleRawCallTool({
        method: 'dom.query',
        params: {},
      });
      assert.equal(result.isError, true);
    }
  );
});

// --- handleAccessTool ---

test('handleAccessTool calls access.request', async () => {
  await withMockedBridge(
    async () => ok({}),
    async (calls) => {
      const result = await handleAccessTool();
      assert.equal(calls[0].method, 'access.request');
      assert.equal(result.isError, undefined);
    }
  );
});
