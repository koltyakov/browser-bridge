// @ts-check

import {
  BridgeError,
  ERROR_CODES,
  createSuccess,
  normalizeRequestParams,
  normalizeWebMcpParams,
} from '../../protocol/src/index.js';
import { runWebMcpInDocument } from './webmcp-document.js';

/**
 * @typedef {{
 *   resolveRequestTarget: (request: import('../../protocol/src/types.js').BridgeRequest) => Promise<import('./background-state.js').ResolvedTabTarget>,
 *   getSessionKey: () => string | null,
 * }} WebMcpDependencies
 */
/**
 * @typedef {{
 *   tabId: number, windowId: number | null, url: string,
 *   details: Record<string, unknown>, finish: (approved: boolean) => void,
 * }} PendingApproval
 */

/**
 * Website tools are deliberately not MCP registrations. This controller owns
 * scope, one-shot approval, document pinning, and execution's no-retry boundary.
 * @param {typeof globalThis.chrome} chromeObj
 * @param {WebMcpDependencies} deps
 */
export function createWebMcpController(chromeObj, deps) {
  const workerId = crypto.randomUUID();
  const approvalPage = chromeObj.runtime.getURL('packages/extension/ui/webmcp-approval.html');
  /** @type {Map<string, PendingApproval>} */
  const approvals = new Map();
  /** @type {Set<number>} */
  const executing = new Set();
  /** Tabs reached only after BBX's access and capability checks. */
  const touched = new Set();

  /** @param {number} tabId @param {string} method @param {import('../../protocol/src/types.js').WebMcpParams} params @param {string} owner @param {string} [documentId] */
  async function run(tabId, method, params, owner, documentId) {
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
      const error =
        /** @type {{ code: import('../../protocol/src/types.js').ErrorCode, message: string, details?: unknown }} */ (
          result.error
        );
      throw new BridgeError(error.code, error.message, error.details);
    }
    return { result, documentId: entry.documentId };
  }

  /** @param {number} tabId */
  async function clearTab(tabId) {
    for (const pending of approvals.values()) if (pending.tabId === tabId) pending.finish(false);
    if (!touched.has(tabId)) return;
    touched.delete(tabId);
    await run(tabId, 'clear', normalizeWebMcpParams(), '').catch(() => {});
  }

  /** @param {number} tabId @param {Record<string, unknown>} details @param {number} timeoutMs @returns {Promise<boolean>} */
  function approve(tabId, details, timeoutMs) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const url = `${approvalPage}#${id}`;
      let settled = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const pending = {
        tabId,
        windowId: /** @type {number | null} */ (null),
        url,
        details,
        /** @param {boolean} approved */
        finish(approved) {
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

  /**
   * Only the exact extension-owned approval page can read payloads or decide.
   * Content scripts share sender.id but must never satisfy this URL check.
   * @param {unknown} message
   * @param {chrome.runtime.MessageSender} sender
   * @param {(response: import('./background-runtime.js').RuntimeResponse) => void} reply
   * @returns {boolean}
   */
  function onMessage(message, sender, reply) {
    const candidate =
      message && typeof message === 'object'
        ? /** @type {Record<string, unknown>} */ (message)
        : {};
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

  /** @param {number} windowId */
  function handleWindowRemoved(windowId) {
    for (const pending of approvals.values())
      if (pending.windowId === windowId) pending.finish(false);
  }

  /** @param {import('../../protocol/src/types.js').BridgeRequest} request */
  async function handle(request) {
    const params = /** @type {import('../../protocol/src/types.js').WebMcpParams} */ (
      normalizeRequestParams(request.method, request.params)
    );
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
