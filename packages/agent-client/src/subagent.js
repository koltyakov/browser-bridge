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
 * @param {string} [method] - Optional bridge method name for disambiguation
 * @returns {{ ok: boolean, summary: string, evidence: unknown }}
 */
export function summarizeBridgeResponse(response, method) {
  if (!response.ok) {
    return {
      ok: false,
      summary: `${response.error.code}: ${response.error.message}`,
      evidence: response.error.details ?? null
    };
  }

  const result = toRecord(response.result);
  if (typeof result.daemon === 'string') {
    return {
      ok: true,
      summary: `Daemon: ${result.daemon}. Extension: ${result.extensionConnected ? 'connected' : 'disconnected'}.`,
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
      summary: `Page: ${result.title} (${result.origin})${hints.length ? ` [${hints.join(', ')}]` : ''}.`,
      evidence: { url: result.url, origin: result.origin, title: result.title, hints: result.hints }
    };
  }
  if ((typeof result.text === 'string' || typeof result.value === 'string') && typeof result.truncated === 'boolean') {
    const text = /** @type {string} */ (result.text ?? result.value);
    const len = typeof result.length === 'number' ? result.length : text.length;
    const label = method === 'dom.get_text' ? 'Element text' : 'Page text';
    return {
      ok: true,
      summary: `${label}: ${len} chars${result.truncated ? ' (truncated)' : ''}.`,
      evidence: { text: text.slice(0, 500), length: len, truncated: result.truncated }
    };
  }
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
  if (Array.isArray(result.nodes) && typeof result.total === 'number' && result.nodes[0]?.role !== undefined) {
    const nodes = /** @type {Array<Record<string, unknown>>} */ (result.nodes);
    const interactive = nodes.filter((/** @type {Record<string, unknown>} */ n) => n.interactive);
    const shown = interactive.length > 0 ? interactive : nodes.filter((/** @type {Record<string, unknown>} */ n) => n.role && n.role !== 'none' && n.role !== 'generic');
    return {
      ok: true,
      summary: `Accessibility tree: ${result.count ?? nodes.length} nodes (${interactive.length} interactive)${result.truncated ? ', truncated' : ''}.`,
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
    const label = method === 'dom.find_by_text' ? 'Found'
      : method === 'dom.find_by_role' ? 'Found'
      : 'DOM query returned';
    return {
      ok: true,
      summary: `${label} ${nodes.length} element(s)${nodes.length > 15 ? '; showing first 15' : ''}.`,
      evidence: compact
    };
  }
  if (typeof result.rolledBack === 'boolean' || typeof result.rolled_back === 'boolean') {
    return {
      ok: true,
      summary: `Patch rolled back.`,
      evidence: result
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
      ok: result.found,
      summary: result.found
        ? `Element found after ${result.duration ?? 0}ms.`
        : `Element not found (timed out after ${result.duration ?? 0}ms).`,
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
      repr = '(empty — may be a Promise, Map, or non-serializable value)';
    } else {
      repr = JSON.stringify(result.value);
    }
    const typeLabel = isNull ? 'null' : result.type;
    return {
      ok: true,
      summary: repr ? `Evaluated to ${typeLabel}: ${repr}` : `Evaluated to ${typeLabel}.`,
      evidence: result
    };
  }
  if (Array.isArray(result.entries) && result.entries.length > 0 && typeof result.entries[0]?.at === 'string' && typeof result.entries[0]?.method === 'string') {
    const entries = /** @type {Array<Record<string, unknown>>} */ (result.entries);
    return {
      ok: true,
      summary: `Log: ${entries.length} entries.`,
      evidence: entries.slice(-10).map((/** @type {Record<string, unknown>} */ e) => ({
        at: e.at, method: e.method, ok: e.ok
      }))
    };
  }
  if (Array.isArray(result.entries) && (result.entries.length > 0 ? (result.entries[0]?.type === 'fetch' || result.entries[0]?.type === 'xhr') : method === 'page.get_network')) {
    const entries = /** @type {Array<Record<string, unknown>>} */ (result.entries);
    return {
      ok: true,
      summary: `Network: ${result.count ?? entries.length} requests (${result.total ?? '?'} total).`,
      evidence: entries.slice(0, 20).map((/** @type {Record<string, unknown>} */ e) => ({
        method: e.method, url: truncateUrl(/** @type {string} */ (e.url)), status: e.status, duration: e.duration
      }))
    };
  }
  if (Array.isArray(result.entries)) {
    const consoleEntries = /** @type {Array<Record<string, unknown>>} */ (result.entries);
    return {
      ok: true,
      summary: `Console: ${result.count ?? consoleEntries.length} entries (${result.total ?? '?'} total).`,
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
  if (typeof result.tabId === 'number' && typeof result.url === 'string' && !result.sessionId) {
    return {
      ok: true,
      summary: `Tab ${result.tabId} created${result.url ? ` (${result.url})` : ''}.`,
      evidence: result
    };
  }
  if (typeof result.clicked === 'boolean') {
    return {
      ok: true,
      summary: `Clicked ${result.elementRef ?? 'element'}.`,
      evidence: { elementRef: result.elementRef }
    };
  }
  if (typeof result.focused === 'boolean') {
    return {
      ok: true,
      summary: `Focused ${result.elementRef ?? 'element'}.`,
      evidence: { elementRef: result.elementRef }
    };
  }
  if (typeof result.typed === 'boolean') {
    return {
      ok: true,
      summary: `Typed into ${result.elementRef ?? 'element'}.`,
      evidence: { elementRef: result.elementRef }
    };
  }
  if (typeof result.pressed === 'boolean') {
    return {
      ok: true,
      summary: `Key pressed${result.key ? ` (${result.key})` : ''}.`,
      evidence: result
    };
  }
  if (typeof result.navigated === 'boolean') {
    return {
      ok: true,
      summary: `Navigated to ${result.url ?? 'page'}.`,
      evidence: { url: result.url }
    };
  }
  if (typeof result.scrolled === 'boolean') {
    return {
      ok: true,
      summary: `Scrolled to (${result.x ?? 0}, ${result.y ?? 0}).`,
      evidence: result
    };
  }
  if (typeof result.resized === 'boolean') {
    return {
      ok: true,
      summary: `Viewport resized to ${result.width ?? '?'}×${result.height ?? '?'}.`,
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
      summary: `Storage (${result.type}): ${result.count} entries.`,
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
      summary: `Element ${desc.join(', ')}.`,
      evidence: { elementRef: result.elementRef, tag: result.tag, id: result.id, role: result.role, text: textValue, bbox: result.bbox }
    };
  }
  if (typeof result.properties === 'object' && result.properties !== null && typeof result.elementRef === 'string') {
    const props = Object.keys(/** @type {object} */ (result.properties));
    return {
      ok: true,
      summary: `Computed ${props.length} style(s) for ${result.elementRef}.`,
      evidence: result.properties
    };
  }
  if (method === 'styles.get_computed') {
    const props = Object.keys(result);
    return {
      ok: true,
      summary: `Computed ${props.length} style(s).`,
      evidence: result
    };
  }
  if (typeof result.content === 'object' && typeof result.border === 'object') {
    const c = /** @type {Record<string, number>} */ (result.content);
    return {
      ok: true,
      summary: `Box model: ${c.width ?? '?'}×${c.height ?? '?'} at (${c.x ?? 0}, ${c.y ?? 0}).`,
      evidence: result
    };
  }
  if (typeof result.x === 'number' && typeof result.y === 'number' && typeof result.width === 'number' && typeof result.height === 'number' &&
      !('clicked' in result || 'hovered' in result || 'focused' in result || 'resized' in result || 'tag' in result || 'elementRef' in result)) {
    return {
      ok: true,
      summary: `Box model: ${result.width}×${result.height} at (${result.x}, ${result.y}).`,
      evidence: result
    };
  }
  if (Array.isArray(result.patches)) {
    return {
      ok: true,
      summary: `${result.patches.length} active patch(es).`,
      evidence: result.patches.slice(0, 10)
    };
  }
  if (typeof result.revoked === 'boolean') {
    return {
      ok: true,
      summary: result.revoked ? 'Session revoked.' : 'Session revoke failed.',
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
