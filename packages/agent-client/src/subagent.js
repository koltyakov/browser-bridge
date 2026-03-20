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
    const nodes = /** @type {Array<Record<string, unknown>>} */ (result.nodes);
    const compact = nodes.slice(0, 15).map((n) => {
      /** @type {Record<string, unknown>} */
      const entry = { ref: n.elementRef, tag: n.tag };
      if (typeof n.text === 'string' && n.text) {
        entry.text = n.text.length > 80 ? `${n.text.slice(0, 79)}\u2026` : n.text;
      }
      if (Array.isArray(n.children) && n.children.length) {
        entry.childCount = n.children.length;
      }
      return entry;
    });
    return {
      ok: true,
      summary: `DOM query returned ${nodes.length} node(s)${nodes.length > 15 ? '; showing first 15' : ''}.`,
      evidence: compact
    };
  }
  if (typeof result.patchId === 'string') {
    return {
      ok: true,
      summary: `Patch ${result.patchId} applied.`,
      evidence: result
    };
  }
  if (typeof result.found === 'boolean') {
    return {
      ok: true,
      summary: result.found
        ? `Element found after ${result.duration ?? 0}ms.`
        : `Element not found (timed out after ${result.duration ?? 0}ms).`,
      evidence: { elementRef: result.elementRef, duration: result.duration }
    };
  }
  if (typeof result.value !== 'undefined' && typeof result.type === 'string') {
    const repr = typeof result.value === 'string'
      ? result.value.length > 200 ? `${result.value.slice(0, 199)}\u2026` : result.value
      : JSON.stringify(result.value);
    return {
      ok: true,
      summary: `Evaluated to ${result.type}: ${repr}`,
      evidence: result
    };
  }
  if (Array.isArray(result.entries) && result.entries.length > 0 && (result.entries[0]?.type === 'fetch' || result.entries[0]?.type === 'xhr')) {
    const entries = /** @type {Array<Record<string, unknown>>} */ (result.entries);
    return {
      ok: true,
      summary: `Network: ${result.count ?? entries.length} requests (${result.total ?? '?'} total).`,
      evidence: entries.slice(0, 20).map((/** @type {Record<string, unknown>} */ e) => ({
        method: e.method, url: e.url, status: e.status, duration: e.duration
      }))
    };
  }
  if (Array.isArray(result.entries)) {
    return {
      ok: true,
      summary: `Console: ${result.count ?? result.entries.length} entries (${result.total ?? '?'} total).`,
      evidence: result.entries.slice(0, 20)
    };
  }
  if (typeof result.html === 'string') {
    return {
      ok: true,
      summary: `HTML fragment: ${result.html.length} chars${result.truncated ? ' (truncated)' : ''}.`,
      evidence: { html: result.html.slice(0, 500), truncated: result.truncated }
    };
  }
  if (typeof result.hovered === 'boolean') {
    return {
      ok: true,
      summary: `Hover ${result.hovered ? 'active' : 'failed'} on ${result.elementRef}.`,
      evidence: result
    };
  }
  if (typeof result.dragged === 'boolean') {
    return {
      ok: true,
      summary: `Drag ${result.dragged ? 'completed' : 'failed'}: ${result.sourceRef} → ${result.destinationRef}.`,
      evidence: result
    };
  }
  if (typeof result.closed === 'boolean') {
    return {
      ok: true,
      summary: `Tab ${result.tabId} closed.`,
      evidence: result
    };
  }
  if (typeof result.metrics === 'object' && result.metrics !== null) {
    const keys = Object.keys(result.metrics);
    return {
      ok: true,
      summary: `Performance: ${keys.length} metrics collected.`,
      evidence: result.metrics
    };
  }
  if (Array.isArray(result.nodes) && typeof result.total === 'number' && result.nodes[0]?.role !== undefined) {
    const interactive = result.nodes.filter((/** @type {Record<string, unknown>} */ n) => n.interactive);
    return {
      ok: true,
      summary: `Accessibility tree: ${result.count} nodes (${interactive.length} interactive)${result.truncated ? ', truncated' : ''}.`,
      evidence: interactive.slice(0, 20).map((/** @type {Record<string, unknown>} */ n) => ({
        nodeId: n.nodeId, role: n.role, name: n.name
      }))
    };
  }
  if (typeof result.count === 'number' && typeof result.type === 'string' && result.entries) {
    return {
      ok: true,
      summary: `Storage (${result.type}): ${result.count} entries.`,
      evidence: result.entries
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
