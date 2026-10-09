import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebMcpController } from '../src/background-webmcp.js';
import { createChromeFake, createChromeEvent } from '../../../tests/_helpers/chromeFake.ts';
import { withDocument } from '../../../tests/_helpers/dom.ts';
import { createRequest } from '../../protocol/src/index.js';
import type { BridgeMethod, WebMcpContext, WebMcpTool } from '../../protocol/src/types.js';

const NativeEvent = globalThis.Event;

async function setup(
  t: import('node:test').TestContext,
  body: (f: {
    controller: ReturnType<typeof createWebMcpController>;
    call: (
      method: BridgeMethod,
      params?: Record<string, unknown>
    ) => ReturnType<ReturnType<typeof createWebMcpController>['handle']>;
    respond: (approved: boolean, senderUrl?: string) => unknown;
    getApproval: (senderUrl?: string) => unknown;
    waitForPopup: () => Promise<void>;
    close: () => void;
    calls: string[];
    api: WebMcpContext;
    executions: () => number;
    setSession: (session: string | null) => void;
    setDocumentMissing: () => void;
  }) => Promise<void>
) {
  await withDocument('<main id="result">idle</main>', async ({ document, window }) => {
    Reflect.deleteProperty(globalThis, '__bbxWebMcp');
    const calls: string[] = [];
    let count = 0;
    const api: WebMcpContext = Object.assign(new EventTarget(), {
      getTools: async () => [
        {
          name: 'set_status',
          description: '<script>unsafe description</script>',
          origin: 'https://example.test',
          window,
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        },
      ],
      executeTool: async (_tool: unknown, args: Record<string, unknown>) => {
        count++;
        document.getElementById('result')!.textContent = String(args.value);
        return 'done';
      },
    });
    Reflect.set(document, 'modelContext', api);
    const onMessage = createChromeEvent();
    const onRemoved = createChromeEvent();
    let popupUrl = '';
    let popupResolve = () => {};
    const opened = new Promise<void>((resolve) => {
      popupResolve = resolve;
    });
    let missing = false;
    const fake = createChromeFake({
      runtime: { onMessage },
      windows: {
        onRemoved,
        async create(properties: { url: string }) {
          popupUrl = properties.url;
          popupResolve();
          return { id: 99 };
        },
        async remove() {},
      },
      scripting: {
        async executeScript(injection: {
          func: (...args: unknown[]) => Promise<unknown>;
          args: unknown[];
          target: { documentIds?: string[] };
        }) {
          const method = String(injection.args[0]);
          calls.push(method);
          if (missing && injection.target.documentIds)
            throw new Error('Document no longer exists.');
          return [
            {
              frameId: 0,
              documentId: 'chrome-doc',
              result: await injection.func(...injection.args),
            },
          ];
        },
      },
    });
    let session: string | null = 'access-session';
    const controller = createWebMcpController(fake as unknown as typeof chrome, {
      resolveRequestTarget: async () => {
        if (!session) throw new Error('Access revoked');
        return { tabId: 10, windowId: 20, title: 'Fixture', url: 'https://example.test/' };
      },
      getSessionKey: () => session,
    });
    t.after(async () => {
      await controller.clearTab(10);
      Reflect.deleteProperty(globalThis, '__bbxWebMcp');
    });
    onMessage.addListener((message, sender, reply) =>
      controller.handleMessage(
        message,
        sender as chrome.runtime.MessageSender,
        reply as (response: unknown) => void
      )
    );
    onRemoved.addListener((windowId) => controller.handleWindowRemoved(Number(windowId)));
    const call = async (method: BridgeMethod, params: Record<string, unknown> = {}) =>
      controller.handle(
        createRequest({
          id: crypto.randomUUID(),
          method,
          params,
          tabId: 10,
          meta: { agent_session: 'test' },
        })
      );
    const message = (type: string, approved?: boolean, senderUrl = popupUrl) => {
      let result: unknown;
      onMessage.dispatch(
        { type, id: popupUrl.split('#')[1], approved },
        { id: 'test-extension-id', url: senderUrl },
        (reply: unknown) => {
          result = reply;
        }
      );
      return result;
    };
    await body({
      controller,
      call,
      respond: (approved, url) => message('webmcp.approval.decide', approved, url),
      getApproval: (url) => message('webmcp.approval.get', undefined, url),
      waitForPopup: async () => {
        await opened;
        await new Promise((resolve) => setImmediate(resolve));
      },
      close: () => {
        onRemoved.dispatch(99);
      },
      calls,
      api,
      executions: () => count,
      setSession: (value) => {
        session = value;
      },
      setDocumentMissing: () => {
        missing = true;
      },
    });
    await controller.clearTab(10);
  });
}

async function ref(call: Parameters<Parameters<typeof setup>[1]>[0]['call']) {
  const catalog = await call('webmcp.list_tools');
  assert.ok(catalog.ok);
  return (catalog.result as { tools: WebMcpTool[] }).tools[0].toolRef;
}

test('WebMCP approval is extension-owned, exact, single-use and required even for read-only hints', async (t) => {
  await setup(t, async ({ call, waitForPopup, respond, getApproval, executions }) => {
    const toolRef = await ref(call);
    const pending = call('webmcp.execute_tool', { toolRef, arguments: { value: 'approved' } });
    await waitForPopup();
    assert.equal(executions(), 0);
    assert.deepEqual(getApproval('https://example.test/'), { ok: false });
    assert.deepEqual(respond(true, 'https://example.test/'), { ok: false });
    assert.equal(executions(), 0);
    const approval = getApproval() as {
      ok: boolean;
      details: { arguments: unknown; tool: WebMcpTool };
    };
    assert.deepEqual(approval.details.arguments, { value: 'approved' });
    assert.equal(approval.details.tool.name, 'set_status');
    await assert.rejects(call('webmcp.execute_tool', { toolRef }), { code: 'WEBMCP_BUSY' });
    respond(true);
    const response = await pending;
    assert.ok(response.ok);
    assert.equal(executions(), 1);
    assert.equal(document.getElementById('result')!.textContent, 'approved');
    assert.deepEqual(respond(true), { ok: false });
  });
});

for (const reason of [
  'declined',
  'closed',
  'revoked',
  'changed',
  'toolchange',
  'navigation',
] as const) {
  test(`WebMCP ${reason} approval never authorizes a replacement or silently repeats execution`, async (t) => {
    await setup(
      t,
      async ({
        call,
        waitForPopup,
        respond,
        close,
        controller,
        setSession,
        setDocumentMissing,
        api,
        executions,
      }) => {
        const toolRef = await ref(call);
        const pending = call('webmcp.execute_tool', { toolRef });
        const assertion = assert.rejects(
          pending,
          reason === 'toolchange'
            ? { code: 'WEBMCP_TOOL_STALE' }
            : reason === 'navigation'
              ? { code: 'WEBMCP_EXECUTION_UNCERTAIN' }
              : reason === 'revoked'
                ? /not approved/
                : { code: 'WEBMCP_APPROVAL_DENIED' }
        );
        await waitForPopup();
        if (reason === 'declined') respond(false);
        if (reason === 'closed') close();
        if (reason === 'revoked') await controller.clearTab(10);
        if (reason === 'changed') {
          setSession('new-session');
          respond(true);
        }
        if (reason === 'toolchange') {
          api.dispatchEvent(new NativeEvent('toolchange'));
          respond(true);
        }
        if (reason === 'navigation') {
          setDocumentMissing();
          respond(true);
        }
        await assertion;
        assert.equal(executions(), 0);
      }
    );
  });
}

test('WebMCP invalid parameters fail before reading a page or opening approval', async (t) => {
  await setup(t, async ({ call, calls }) => {
    await assert.rejects(call('webmcp.execute_tool', { toolRef: 'invalid', arguments: [] }), {
      code: 'INVALID_REQUEST',
    });
    assert.deepEqual(calls, []);
  });
});
