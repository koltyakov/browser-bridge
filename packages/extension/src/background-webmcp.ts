import {
  BridgeError,
  ERROR_CODES,
  createSuccess,
  normalizeRequestParams,
  normalizeWebMcpParams,
} from '../../../protocol/src/index.js';
import { runWebMcpInDocument } from './webmcp-document.js';

export type WebMcpDependencies = {
  resolveRequestTarget: (
    request: import('../../../protocol/src/types.js').BridgeRequest
  ) => Promise<import('./background-state.js').ResolvedTabTarget>;
  getSessionKey: () => string | null;
};
export type PendingApproval = {
  tabId: number;
  windowId: number | null;
  url: string;
  details: Record<string, unknown>;
  finish: (approved: boolean) => void;
};

/** Website tools are deliberately not MCP registrations. This controller owns
scope, one-shot approval, document pinning, and execution's no-retry boundary. */
export function createWebMcpController(
  chromeObj: typeof globalThis.chrome,
  deps: WebMcpDependencies
) {
  const workerId = crypto.randomUUID();
  const approvalPage = chromeObj.runtime.getURL('ui/webmcp-approval.html');

  const approvals: Map<string, PendingApproval> = new Map();

  const executing: Set<number> = new Set();
  /** Tabs reached only after BBX's access and capability checks. */
  const touched = new Set();

  async function run(
    tabId: number,
    method: string,
    params: import('../../../protocol/src/types.js').WebMcpParams,
    owner: string,
    documentId?: string
  ) {
    const results = await chromeObj.scripting.executeScript({
      target: documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: runWebMcpInDocument,
      args: [method, params, owner],
    });
    const entry = results?.[0];
    const result = entry?.result;
    if (!result || typeof result !== 'object')
      throw new BridgeError(
        ERROR_CODES.WEBMCP_UNAVAILABLE,
        'WebMCP document did not return a response.'
      );
    if (result.error && typeof result.error === 'object') {
      const error = result.error as {
        code: import('../../../protocol/src/types.js').ErrorCode;
        message: string;
        details?: unknown;
      };
      throw new BridgeError(error.code, error.message, error.details);
    }
    return { result, documentId: entry.documentId };
  }

  async function clearTab(tabId: number) {
    for (const pending of approvals.values()) if (pending.tabId === tabId) pending.finish(false);
    if (!touched.has(tabId)) return;
    touched.delete(tabId);
    await run(tabId, 'clear', normalizeWebMcpParams(), '').catch(() => {});
  }

  function approve(
    tabId: number,
    details: Record<string, unknown>,
    timeoutMs: number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const url = `${approvalPage}#${id}`;
      let settled = false;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = {
        tabId,
        windowId: null as number | null,
        url,
        details,

        finish(approved: boolean) {
          if (settled) return;
          settled = true;
          approvals.delete(id);
          clearTimeout(timer);
          if (pending.windowId !== null)
            void chromeObj.windows.remove(pending.windowId).catch(() => {});
          resolve(approved);
        },
      };
      approvals.set(id, pending);
      timer = setTimeout(() => pending.finish(false), timeoutMs);
      void chromeObj.windows
        .create({ url, type: 'popup', width: 560, height: 680, focused: true })
        .then((created) => {
          pending.windowId = created?.id ?? null;
          if (settled && pending.windowId !== null)
            void chromeObj.windows.remove(pending.windowId).catch(() => {});
          if (pending.windowId === null) pending.finish(false);
        })
        .catch(() => pending.finish(false));
    });
  }

  /** Only the exact extension-owned approval page can read payloads or decide.
Content scripts share sender.id but must never satisfy this URL check. */
  function onMessage(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    reply: (response: import('./background-runtime.js').RuntimeResponse) => void
  ): boolean {
    const candidate =
      message && typeof message === 'object' ? (message as Record<string, unknown>) : {};
    if (candidate.type !== 'webmcp.approval.get' && candidate.type !== 'webmcp.approval.decide')
      return false;
    const pending = typeof candidate.id === 'string' ? approvals.get(candidate.id) : undefined;
    if (!pending || sender.id !== chromeObj.runtime.id || sender.url !== pending.url) {
      reply({ ok: false });
      return false;
    }
    if (candidate.type === 'webmcp.approval.get') reply({ ok: true, details: pending.details });
    else {
      // Consumed once, never stored as a reusable grant or caller boolean.
      reply({ ok: true });
      pending.finish(candidate.approved === true);
    }
    return false;
  }

  function handleWindowRemoved(windowId: number) {
    for (const pending of approvals.values())
      if (pending.windowId === windowId) pending.finish(false);
  }

  async function handle(request: import('../../../protocol/src/types.js').BridgeRequest) {
    const params = normalizeRequestParams(
      request.method,
      request.params
    ) as import('../../../protocol/src/types.js').WebMcpParams;
    const target = await deps.resolveRequestTarget(request);
    const sessionKey = deps.getSessionKey();
    if (!sessionKey) throw new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Window access is disabled.');
    touched.add(target.tabId);
    const owner = `${workerId}:${sessionKey}:${String(request.meta?.agent_session ?? 'default')}`;
    if (request.method !== 'webmcp.execute_tool') {
      const { result } = await run(target.tabId, request.method, params, owner);
      return createSuccess(request.id, result, { method: request.method });
    }
    if (executing.has(target.tabId))
      throw new BridgeError(
        ERROR_CODES.WEBMCP_BUSY,
        'Another WebMCP approval or execution is pending in this tab.'
      );
    executing.add(target.tabId);
    try {
      const prepared = await run(target.tabId, 'webmcp.get_tool', params, owner);
      if (!prepared.documentId)
        throw new BridgeError(
          ERROR_CODES.WEBMCP_UNAVAILABLE,
          'Chrome did not provide document identity for execution.'
        );
      const approved = await approve(
        target.tabId,
        {
          tabId: target.tabId,
          origin: new URL(target.url).origin,
          tool: prepared.result.tool,
          arguments: params.arguments,
        },
        params.approvalTimeoutMs
      );
      if (!approved)
        throw new BridgeError(
          ERROR_CODES.WEBMCP_APPROVAL_DENIED,
          'WebMCP execution was not approved.',
          { dispatched: false }
        );
      // Approval of a prior access session must not survive disable/re-enable.
      const revalidated = await deps.resolveRequestTarget(request);
      if (
        deps.getSessionKey() !== sessionKey ||
        revalidated.tabId !== target.tabId ||
        revalidated.windowId !== target.windowId ||
        revalidated.url !== target.url
      )
        throw new BridgeError(
          ERROR_CODES.WEBMCP_APPROVAL_DENIED,
          'Window access changed after approval.',
          { dispatched: false }
        );
      try {
        const { result } = await run(
          target.tabId,
          request.method,
          params,
          owner,
          prepared.documentId
        );
        return createSuccess(request.id, result, { method: request.method });
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError(
          ERROR_CODES.WEBMCP_EXECUTION_UNCERTAIN,
          'The document or transport disappeared during dispatch. Inspect postconditions; do not replay.',
          { dispatched: 'unknown', outcome: 'uncertain' }
        );
      }
    } finally {
      executing.delete(target.tabId);
    }
  }

  return { handle, clearTab, handleMessage: onMessage, handleWindowRemoved };
}
