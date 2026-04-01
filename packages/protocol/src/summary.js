// @ts-check

import {
  estimateJsonPayloadCost,
  getCostClass,
} from './index.js';

/** @typedef {import('./types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('./types.js').BridgeMethod} SummaryMethod */
/**
 * @typedef {{
 *   tabId: number,
 *   active: boolean,
 *   origin: string,
 *   title: string
 * }} TabResult
 */

/**
 * @typedef {{ text: (r: Record<string, unknown>) => string, evidence: (r: Record<string, unknown>) => unknown }} ActionSummary
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   summary: string,
 *   evidence: unknown
 * }} BridgeSummary
 */

/**
 * @typedef {BridgeSummary & {
 *   transportBytes: number,
 *   transportTokens: number,
 *   transportCostClass: 'cheap' | 'moderate' | 'heavy' | 'extreme',
 *   summaryBytes: number,
 *   summaryTokens: number,
 *   summaryCostClass: 'cheap' | 'moderate' | 'heavy' | 'extreme'
 * }} AnnotatedBridgeSummary
 */

/**
 * @typedef {AnnotatedBridgeSummary & {
 *   method: SummaryMethod,
 *   tabId: number | null,
 *   durationMs: number,
 *   approxTokens: number,
 *   meta?: Record<string, unknown>,
 *   error: unknown,
 *   response: unknown
 * }} BatchItemSummary
 */

/** @type {Record<string, ActionSummary>} */
const ACTION_SUMMARIES = {
  hovered:   { text: r => `Hover ${r.hovered ? 'active' : 'failed'} on ${r.elementRef}.`, evidence: r => r },
  dragged:   { text: r => `Drag ${r.dragged ? 'completed' : 'failed'}: ${r.sourceRef} → ${r.destinationRef}.`, evidence: r => r },
  closed:    { text: r => `Tab ${r.tabId} closed.`, evidence: r => r },
  clicked:   { text: r => `Clicked ${r.elementRef ?? 'element'}.`, evidence: r => ({ elementRef: r.elementRef }) },
  focused:   { text: r => `Focused ${r.elementRef ?? 'element'}.`, evidence: r => ({ elementRef: r.elementRef }) },
  typed:     { text: r => `Typed into ${r.elementRef ?? 'element'}.`, evidence: r => ({ elementRef: r.elementRef }) },
  pressed:   { text: r => `Key pressed${r.key ? ` (${r.key})` : ''}.`, evidence: r => r },
  navigated: { text: r => `Navigated to ${r.url ?? 'page'}.`, evidence: r => ({ url: r.url }) },
  scrolled:  { text: r => `Scrolled to (${r.x ?? 0}, ${r.y ?? 0}).`, evidence: r => r },
  resized:   { text: r => `Viewport resized to ${r.width ?? '?'}×${r.height ?? '?'}.`, evidence: r => r },
};

/**
 * Add transport and summary payload estimates without changing the compact
 * shape consumed by existing clients.
 *
 * @param {BridgeSummary} summary
 * @param {BridgeResponse} response
 * @returns {AnnotatedBridgeSummary}
 */
export function annotateBridgeSummary(summary, response) {
  const transportBytes = getNumericMetaField(response.meta, 'transport_bytes')
    ?? getNumericMetaField(response.meta, 'response_bytes')
    ?? estimateJsonPayloadCost(response.ok ? response.result : { error: response.error }).bytes;
  const transportTokens = getNumericMetaField(response.meta, 'transport_approx_tokens')
    ?? getNumericMetaField(response.meta, 'approx_tokens')
    ?? estimateJsonPayloadCost(response.ok ? response.result : { error: response.error }).approxTokens;
  const summaryCost = estimateJsonPayloadCost(summary);

  return {
    ...summary,
    transportBytes,
    transportTokens,
    transportCostClass: getMetaCostClass(response.meta, 'transport_cost_class')
      ?? getMetaCostClass(response.meta, 'cost_class')
      ?? getCostClass(transportTokens),
    summaryBytes: summaryCost.bytes,
    summaryTokens: summaryCost.approxTokens,
    summaryCostClass: summaryCost.costClass,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @param {string} field
 * @returns {number | null}
 */
function getNumericMetaField(meta, field) {
  const value = meta?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @param {string} field
 * @returns {'cheap' | 'moderate' | 'heavy' | 'extreme' | null}
 */
function getMetaCostClass(meta, field) {
  const value = meta?.[field];
  return value === 'moderate' || value === 'heavy' || value === 'extreme' || value === 'cheap'
    ? value
    : null;
}

/**
 * @param {BridgeResponse} response
 * @param {string} [method] - Optional bridge method name for disambiguation
 * @returns {BridgeSummary}
 */
export function summarizeBridgeResponse(response, method) {
  const protocolWarning = getProtocolWarning(response.meta);
  if (!response.ok) {
    const hint = summarizeErrorHint(response.error.code);
    return {
      ok: false,
      summary: appendProtocolWarning(
        `${response.error.code}: ${response.error.message}${hint ? ` ${hint}` : ''}`,
        protocolWarning
      ),
      evidence: response.error.details ?? null
    };
  }

  const result = toRecord(response.result);
  if (typeof result.daemon === 'string') {
    const access = result.access && typeof result.access === 'object'
      ? /** @type {Record<string, unknown>} */ (result.access)
      : null;
    const accessSummary = access == null
      ? ''
      : access.enabled
        ? ` Access: ${access.routeReady ? `ready on tab ${access.routeTabId}.` : `enabled${typeof access.reason === 'string' ? ` (${access.reason})` : '.'}`}`
        : ' Access: disabled.';
    const connectedExtensions = Array.isArray(result.connectedExtensions)
      ? /** @type {Array<Record<string, unknown>>} */ (result.connectedExtensions)
      : [];
    const extensionSummary = result.extensionConnected
      ? `connected (${connectedExtensions.length}: ${connectedExtensions.map((ext) => {
        const label = `${ext.browserName ?? 'unknown'}${ext.profileLabel ? '/' + ext.profileLabel : ''}`;
        return ext.accessEnabled ? `${label}*` : label;
      }).join(', ')})`
      : 'disconnected';
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Daemon: ${result.daemon}. Extension: ${extensionSummary}.${accessSummary}`,
        protocolWarning
      ),
      evidence: result
    };
  }
  if (Array.isArray(result.mcpClients) && Array.isArray(result.skillTargets)) {
    const configuredMcp = result.mcpClients.filter((entry) => entry && typeof entry === 'object' && /** @type {Record<string, unknown>} */ (entry).configured).length;
    const installedSkills = result.skillTargets.filter((entry) => entry && typeof entry === 'object' && /** @type {Record<string, unknown>} */ (entry).installed).length;
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Setup: MCP configured for ${configuredMcp}/${result.mcpClients.length} clients; skill installed for ${installedSkills}/${result.skillTargets.length} targets.`,
        protocolWarning
      ),
      evidence: result
    };
  }
  if (typeof result.url === 'string' && typeof result.title === 'string' && typeof result.origin === 'string') {
    /** @type {string[]} */
    const hints = [];
    if (result.hints && typeof result.hints === 'object') {
      for (const [k, v] of Object.entries(result.hints)) {
        if (v) hints.push(k);
      }
    }
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Page: ${result.title} (${result.origin})${hints.length ? ` [${hints.join(', ')}]` : ''}.`,
        protocolWarning
      ),
      evidence: { url: result.url, origin: result.origin, title: result.title, hints: result.hints }
    };
  }
  if ((typeof result.text === 'string' || typeof result.value === 'string') && typeof result.truncated === 'boolean') {
    const text = /** @type {string} */ (result.text ?? result.value);
    const len = typeof result.length === 'number' ? result.length : text.length;
    const label = method === 'dom.get_text' ? 'Element text' : 'Page text';
    return {
      ok: true,
      summary: appendProtocolWarning(
        `${label}: ${len} chars${result.truncated ? ' (truncated)' : ''}.`,
        protocolWarning
      ),
      evidence: { text: text.slice(0, 500), length: len, truncated: result.truncated }
    };
  }
  if (Array.isArray(result.tabs)) {
    const tabs = /** @type {TabResult[]} */ (result.tabs);
    return {
      ok: true,
      summary: appendProtocolWarning(`Bridge listed ${tabs.length} tab(s).`, protocolWarning),
      evidence: tabs.slice(0, 10).map((tab) => ({
        tabId: tab.tabId,
        active: tab.active,
        origin: tab.origin,
        title: tab.title
      }))
    };
  }
  if (Array.isArray(result.nodes) && typeof result.total === 'number' && result.nodes[0]?.role !== undefined) {
    const nodes = /** @type {Array<Record<string, unknown>>} */ (result.nodes);
    const interactive = nodes.filter((/** @type {Record<string, unknown>} */ n) => n.interactive);
    const shown = interactive.length > 0 ? interactive : nodes.filter((/** @type {Record<string, unknown>} */ n) => n.role && n.role !== 'none' && n.role !== 'generic');
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Accessibility tree: ${result.count ?? nodes.length} nodes (${interactive.length} interactive)${result.truncated ? ', truncated' : ''}.`,
        protocolWarning
      ),
      evidence: shown.slice(0, 20).map((/** @type {Record<string, unknown>} */ n) => {
        /** @type {Record<string, unknown>} */
        const entry = { role: n.role, name: n.name };
        if (n.interactive) entry.interactive = true;
        if (n.value) entry.value = n.value;
        return entry;
      })
    };
  }
  if (Array.isArray(result.nodes)) {
    const nodes = /** @type {Array<Record<string, unknown>>} */ (result.nodes);
    const compact = nodes.slice(0, 15).map((n) => {
      /** @type {Record<string, unknown>} */
      const entry = { ref: n.elementRef, tag: n.tag };
      if (n.id) entry.id = n.id;
      if (typeof n.attrs === 'object' && n.attrs !== null) {
        const attrs = /** @type {Record<string, unknown>} */ (n.attrs);
        if (attrs.id) entry.id = attrs.id;
        if (typeof attrs.class === 'string') entry.cls = attrs.class.split(' ').slice(0, 3).join(' ');
        if (attrs.role) entry.role = attrs.role;
        if (attrs['aria-label']) entry.label = attrs['aria-label'];
        if (attrs['data-testid']) entry.testId = attrs['data-testid'];
      }
      if (!entry.role && n.role) entry.role = n.role;
      if (!entry.label && n.name) entry.label = n.name;
      const text = typeof n.textExcerpt === 'string' ? n.textExcerpt : typeof n.text === 'string' ? n.text : '';
      if (text) {
        entry.text = text.length > 80 ? `${text.slice(0, 79)}\u2026` : text;
      }
      if (Array.isArray(n.children) && n.children.length) {
        entry.childCount = n.children.length;
      }
      return entry;
    });
    let label;
    if (method === 'dom.find_by_text' || method === 'dom.find_by_role') {
      label = 'Found';
    } else {
      label = 'DOM query returned';
    }
    return {
      ok: true,
      summary: appendProtocolWarning(
        `${label} ${nodes.length} element(s)${nodes.length > 15 ? '; showing first 15' : ''}.`,
        protocolWarning
      ),
      evidence: compact
    };
  }
  if (typeof result.rolledBack === 'boolean' || typeof result.rolled_back === 'boolean') {
    return {
      ok: true,
      summary: appendProtocolWarning('Patch rolled back.', protocolWarning),
      evidence: result
    };
  }
  if (typeof result.patchId === 'string') {
    return {
      ok: true,
      summary: appendProtocolWarning(`Patch ${result.patchId} applied.`, protocolWarning),
      evidence: result
    };
  }
  if (typeof result.found === 'boolean') {
    return {
      ok: result.found,
      summary: appendProtocolWarning(
        result.found
          ? `Element found after ${result.duration ?? 0}ms.`
          : `Element not found (timed out after ${result.duration ?? 0}ms).`,
        protocolWarning
      ),
      evidence: { elementRef: result.elementRef ?? null, duration: result.duration }
    };
  }
  if (typeof result.value !== 'undefined' && typeof result.type === 'string') {
    let repr;
    const isNull = result.value === null && result.type !== 'undefined';
    if (result.type === 'undefined') {
      repr = '';
    } else if (isNull) {
      repr = '';
    } else if (typeof result.value === 'string') {
      repr = result.value.length > 200 ? `${result.value.slice(0, 199)}\u2026` : result.value;
    } else if (typeof result.value === 'object' && result.value !== null && Object.keys(result.value).length === 0) {
      repr = '(empty - may be a Promise, Map, or non-serializable value)';
    } else {
      repr = JSON.stringify(result.value);
    }
    const typeLabel = isNull ? 'null' : result.type;
    return {
      ok: true,
      summary: appendProtocolWarning(
        repr ? `Evaluated to ${typeLabel}: ${repr}` : `Evaluated to ${typeLabel}.`,
        protocolWarning
      ),
      evidence: result
    };
  }
  if (Array.isArray(result.entries) && result.entries.length > 0 && typeof result.entries[0]?.at === 'string' && typeof result.entries[0]?.method === 'string') {
    const entries = /** @type {Array<Record<string, unknown>>} */ (result.entries);
    return {
      ok: true,
      summary: appendProtocolWarning(`Log: ${entries.length} entries.`, protocolWarning),
      evidence: entries.slice(-10).map((/** @type {Record<string, unknown>} */ e) => ({
        at: e.at, method: e.method, ok: e.ok, ...(typeof e.source === 'string' && e.source ? { source: e.source } : {})
      }))
    };
  }
  if (Array.isArray(result.entries) && (result.entries.length > 0 ? (result.entries[0]?.type === 'fetch' || result.entries[0]?.type === 'xhr') : method === 'page.get_network')) {
    const entries = /** @type {Array<Record<string, unknown>>} */ (result.entries);
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Network: ${result.count ?? entries.length} requests (${result.total ?? '?'} total).`,
        protocolWarning
      ),
      evidence: entries.slice(0, 20).map((/** @type {Record<string, unknown>} */ e) => ({
        method: e.method, url: truncateUrl(/** @type {string} */ (e.url)), status: e.status, duration: e.duration
      }))
    };
  }
  if (Array.isArray(result.entries)) {
    const consoleEntries = /** @type {Array<Record<string, unknown>>} */ (result.entries);
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Console: ${result.count ?? consoleEntries.length} entries (${result.total ?? '?'} total).`,
        protocolWarning
      ),
      evidence: consoleEntries.slice(0, 20).map((/** @type {Record<string, unknown>} */ e) => {
        /** @type {Record<string, unknown>} */
        const entry = { level: e.level, args: e.args };
        if (typeof e.ts === 'number') {
          entry.ago = formatRelativeTime(e.ts);
        }
        return entry;
      })
    };
  }
  if (typeof result.html === 'string') {
    return {
      ok: true,
      summary: appendProtocolWarning(
        `HTML fragment: ${result.html.length} chars${result.truncated ? ' (truncated)' : ''}.`,
        protocolWarning
      ),
      evidence: { html: result.html.slice(0, 500), truncated: result.truncated }
    };
  }
  for (const [field, handler] of Object.entries(ACTION_SUMMARIES)) {
    if (typeof result[field] === 'boolean') {
      return {
        ok: true,
        summary: appendProtocolWarning(handler.text(result), protocolWarning),
        evidence: handler.evidence(result)
      };
    }
  }
  if (typeof result.tabId === 'number' && typeof result.url === 'string') {
    const actionMethod =
      typeof result.method === 'string' ? result.method : method;
    if (actionMethod === 'navigation.navigate') {
      return {
        ok: true,
        summary: appendProtocolWarning(`Navigated to ${result.url || 'page'}.`, protocolWarning),
        evidence: {
          url: result.url,
          title: result.title,
          status: result.status,
          tabId: result.tabId,
        },
      };
    }
    return {
      ok: true,
      summary: appendProtocolWarning(`Tab ${result.tabId} created${result.url ? ` (${result.url})` : ''}.`, protocolWarning),
      evidence: result
    };
  }
  if (typeof result.metrics === 'object' && result.metrics !== null) {
    const keys = Object.keys(result.metrics);
    return {
      ok: true,
      summary: appendProtocolWarning(`Performance: ${keys.length} metrics collected.`, protocolWarning),
      evidence: result.metrics
    };
  }
  if (typeof result.count === 'number' && typeof result.type === 'string' && result.entries) {
    const entries = /** @type {Record<string, unknown>} */ (result.entries);
    /** @type {Record<string, string>} */
    const safe = {};
    for (const [k, v] of Object.entries(entries)) {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      safe[k] = s.length > 80 ? `${s.slice(0, 79)}…` : s;
    }
    return {
      ok: true,
      summary: appendProtocolWarning(`Storage (${result.type}): ${result.count} entries.`, protocolWarning),
      evidence: safe
    };
  }
  if (typeof result.tag === 'string' && typeof result.elementRef === 'string' && typeof result.bbox === 'object') {
    const desc = [result.tag];
    if (result.id) desc[0] += `#${result.id}`;
    const textValue = typeof result.text === 'object' && result.text !== null && 'value' in result.text
      ? /** @type {{ value: string }} */ (result.text).value
      : typeof result.text === 'string' ? result.text : '';
    if (textValue) desc.push(String(textValue).slice(0, 60));
    const bbox = /** @type {Record<string, number>} */ (result.bbox);
    if (bbox.width && bbox.height) {
      desc.push(`${bbox.width}\u00d7${bbox.height}`);
    }
    return {
      ok: true,
      summary: appendProtocolWarning(`Element ${desc.join(', ')}.`, protocolWarning),
      evidence: { elementRef: result.elementRef, tag: result.tag, id: result.id, role: result.role, text: textValue, bbox: result.bbox }
    };
  }
  if (typeof result.properties === 'object' && result.properties !== null && typeof result.elementRef === 'string') {
    const props = Object.keys(/** @type {object} */ (result.properties));
    return {
      ok: true,
      summary: appendProtocolWarning(`Computed ${props.length} style(s) for ${result.elementRef}.`, protocolWarning),
      evidence: result.properties
    };
  }
  if (method === 'styles.get_computed') {
    const props = Object.keys(result);
    return {
      ok: true,
      summary: appendProtocolWarning(`Computed ${props.length} style(s).`, protocolWarning),
      evidence: result
    };
  }
  if (typeof result.content === 'object' && typeof result.border === 'object') {
    const c = /** @type {Record<string, number>} */ (result.content);
    return {
      ok: true,
      summary: appendProtocolWarning(`Box model: ${c.width ?? '?'}×${c.height ?? '?'} at (${c.x ?? 0}, ${c.y ?? 0}).`, protocolWarning),
      evidence: result
    };
  }
  if (typeof result.x === 'number' && typeof result.y === 'number' && typeof result.width === 'number' && typeof result.height === 'number' &&
      !('clicked' in result || 'hovered' in result || 'focused' in result || 'resized' in result || 'tag' in result || 'elementRef' in result)) {
    return {
      ok: true,
      summary: appendProtocolWarning(`Box model: ${result.width}×${result.height} at (${result.x}, ${result.y}).`, protocolWarning),
      evidence: result
    };
  }
  if (Array.isArray(response.result) && looksLikePatchArray(response.result, method)) {
    const patches = /** @type {Array<Record<string, unknown>>} */ (response.result);
    return {
      ok: true,
      summary: appendProtocolWarning(`${patches.length} active patch(es).`, protocolWarning),
      evidence: patches.slice(0, 10)
    };
  }
  if (Array.isArray(result.patches)) {
    return {
      ok: true,
      summary: appendProtocolWarning(`${result.patches.length} active patch(es).`, protocolWarning),
      evidence: result.patches.slice(0, 10)
    };
  }
  const keys = Object.keys(result);
  return {
    ok: true,
    summary: appendProtocolWarning(`Bridge method succeeded with ${keys.length} top-level fields.`, protocolWarning),
    evidence: keys.slice(0, 10)
  };
}

/**
 * @param {{ method: SummaryMethod, tabId: number | null, response: BridgeResponse, durationMs: number }} input
 * @returns {BatchItemSummary}
 */
export function summarizeBatchResponseItem({ method, tabId, response, durationMs }) {
  const summary = annotateBridgeSummary(summarizeBridgeResponse(response, method), response);
  const cost = estimateJsonPayloadCost(response.ok ? response.result : { error: response.error });
  return {
    method,
    tabId,
    ...summary,
    durationMs,
    approxTokens: cost.approxTokens,
    meta: response.meta,
    error: response.ok ? null : response.error,
    response: response.ok ? response.result : null
  };
}

/**
 * @param {{ method: SummaryMethod, tabId: number | null, error: unknown, durationMs: number }} input
 * @returns {BatchItemSummary}
 */
export function summarizeBatchErrorItem({ method, tabId, error, durationMs }) {
  const message = error instanceof Error ? error.message : String(error);
  const response = /** @type {BridgeResponse} */ ({
    id: 'batch_error',
    ok: false,
    result: null,
    error: {
      code: 'INTERNAL_ERROR',
      message,
      details: null
    },
    meta: { protocol_version: '1.0' }
  });
  const summary = annotateBridgeSummary(summarizeBridgeResponse(response, method), response);
  return {
    method,
    tabId,
    ...summary,
    durationMs,
    approxTokens: 0,
    meta: response.meta,
    error: response.error,
    response: null
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

/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @returns {string | null}
 */
function getProtocolWarning(meta) {
  return typeof meta?.protocol_warning === 'string' && meta.protocol_warning.trim()
    ? meta.protocol_warning
    : null;
}

/**
 * @param {string} summary
 * @param {string | null} warning
 * @returns {string}
 */
function appendProtocolWarning(summary, warning) {
  return warning ? `${summary} Protocol warning: ${warning}` : summary;
}

/**
 * Truncate a URL to a readable length, keeping origin + pathname and trimming query strings.
 *
 * @param {string} url
 * @returns {string}
 */
function truncateUrl(url) {
  if (!url || url.length <= 120) return url;
  try {
    const u = new URL(url);
    const base = `${u.origin}${u.pathname}`;
    if (base.length > 120) return `${base.slice(0, 119)}\u2026`;
    if (u.search) return `${base}?…`;
    return base;
  } catch {
    return url.length > 120 ? `${url.slice(0, 119)}\u2026` : url;
  }
}

/**
 * @param {string} code
 * @returns {string}
 */
function summarizeErrorHint(code) {
  if (code === 'ELEMENT_STALE') {
    return 'Re-query the current page after navigation or DOM updates.';
  }
  return '';
}

/**
 * Check if an array looks like a list of patch entries.
 * Returns true for empty arrays when method context suggests patch.list.
 *
 * @param {unknown[]} arr
 * @param {string} [method]
 * @returns {boolean}
 */
function looksLikePatchArray(arr, method) {
  if (!Array.isArray(arr)) return false;
  if (arr.length === 0) return method === 'patch.list';
  const first = arr[0];
  return (
    first !== null &&
    typeof first === 'object' &&
    'patchId' in first &&
    'kind' in first
  );
}

/**
 * Format a Unix-ms timestamp as a human-readable relative time (e.g., "2m ago", "just now").
 *
 * @param {number} ts
 * @returns {string}
 */
function formatRelativeTime(ts) {
  const delta = Date.now() - ts;
  if (delta < 0) return 'just now';
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
