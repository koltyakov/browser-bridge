// @ts-check

/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/**
 * @typedef {{
 *   sessionId: string,
 *   tabId: number,
 *   origin: string,
 *   expiresAt: number
 * }} SessionResult
 */

/**
 * @typedef {{
 *   tabId: number,
 *   active: boolean,
 *   origin: string,
 *   title: string
 * }} TabResult
 */

/**
 * @param {BridgeResponse} response
 * @returns {{ ok: boolean, summary: string, evidence: unknown }}
 */
export function summarizeBridgeResponse(response) {
  if (!response.ok) {
    return {
      ok: false,
      summary: `${response.error.code}: ${response.error.message}`,
      evidence: response.error.details ?? null
    };
  }

  const result = toRecord(response.result);
  if (typeof result.sessionId === 'string') {
    const sessionResult = /** @type {SessionResult} */ (result);
    return {
      ok: true,
      summary: `Session ready for tab ${sessionResult.tabId} at ${sessionResult.origin}.`,
      evidence: {
        sessionId: sessionResult.sessionId,
        tabId: sessionResult.tabId,
        origin: sessionResult.origin,
        expiresAt: sessionResult.expiresAt
      }
    };
  }
  if (Array.isArray(result.tabs)) {
    const tabs = /** @type {TabResult[]} */ (result.tabs);
    return {
      ok: true,
      summary: `Bridge listed ${tabs.length} tab(s).`,
      evidence: tabs.slice(0, 10).map((tab) => ({
        tabId: tab.tabId,
        active: tab.active,
        origin: tab.origin,
        title: tab.title
      }))
    };
  }
  if (Array.isArray(result.nodes)) {
    return {
      ok: true,
      summary: `DOM query returned ${result.nodes.length} node(s).`,
      evidence: result.nodes
    };
  }
  if (typeof result.patchId === 'string') {
    return {
      ok: true,
      summary: `Patch ${result.patchId} applied.`,
      evidence: result
    };
  }
  const keys = Object.keys(result);
  return {
    ok: true,
    summary: `Bridge method succeeded with ${keys.length} top-level fields.`,
    evidence: keys.slice(0, 10)
  };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function toRecord(value) {
  return value && typeof value === 'object'
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}
