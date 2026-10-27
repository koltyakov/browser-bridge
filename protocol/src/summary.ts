import { getErrorRecovery } from './errors.js';
import { sanitizeIncidentalUrl } from './incidental-sanitizer.js';
import { describeTabList, paginateTabList } from './tab-list.js';

export type BridgeResponse = import('./types.js').BridgeResponse;

export type TabResult = {
  tabId: number;
  active: boolean;
  origin: string;
  title: string;
};

export type ActionSummary = {
  text: (r: Record<string, unknown>) => string;
  evidence: (r: Record<string, unknown>) => unknown;
};

export type BridgeSummary = {
  ok: boolean;
  summary: string;
  evidence: unknown;
  recovery?: import('./types.js').BridgeRecovery | null;
  pagination?: import('./types.js').TabPagination;
};

/** Evaluate values longer than this stay out of the summary; evidence holds them. */
const MAX_EVALUATE_SUMMARY_CHARS = 160;
const EVALUATE_PREVIEW_CHARS = 80;

/** Keep evaluate summaries short: small values inline, larger ones as a shape
description, because the full value is already delivered in evidence. */
function summarizeEvaluateValue(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  if (json.length <= MAX_EVALUATE_SUMMARY_CHARS) return json;
  const shape = Array.isArray(value)
    ? `${value.length} item(s)`
    : value && typeof value === 'object'
      ? `${Object.keys(value).length} key(s)`
      : `${json.length} chars`;
  return `${shape}, ${json.length} chars as JSON; full value in evidence.value`;
}

function describeTabResult(method: string | undefined, result: Record<string, unknown>): string {
  const url = typeof result.url === 'string' && result.url ? ` (${result.url})` : '';
  switch (method) {
    case 'navigation.reload':
      return `Reloaded tab ${result.tabId}${url}.`;
    case 'navigation.go_back':
      return `Navigated back in tab ${result.tabId}${url}.`;
    case 'navigation.go_forward':
      return `Navigated forward in tab ${result.tabId}${url}.`;
    case 'tabs.activate':
      return `Tab ${result.tabId} activated${url}.`;
    case 'page.wait_for_load_state':
      return `Tab ${result.tabId} ${typeof result.status === 'string' ? result.status : 'ready'}${url}.`;
    default:
      return `Tab ${result.tabId} created${url}.`;
  }
}

const ROUTINE_STRATEGIES = new Set(['elementRef', 'selector-first', 'locator-first']);

/** Keep input evidence lean: resolution/execution metadata only when something
notable happened (scroll, wait, ranking, recovery, CDP, fallback), plus any
observed effects. Routine successes cost a few tokens instead of ~100. */
function compactInputEvidence(
  r: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const evidence: Record<string, unknown> = { elementRef: r.elementRef ?? null, ...extra };
  const resolution = toRecord(r.resolution);
  if (
    resolution.scrolled === true ||
    resolution.recovered === true ||
    (typeof resolution.waitedMs === 'number' && resolution.waitedMs > 0) ||
    (typeof resolution.strategy === 'string' && !ROUTINE_STRATEGIES.has(resolution.strategy))
  ) {
    const notable: Record<string, unknown> = { strategy: resolution.strategy };
    for (const key of ['scrolled', 'recovered', 'waitedMs', 'candidateCount', 'oldRef', 'newRef']) {
      const value = resolution[key];
      if (value !== undefined && value !== false && !(key === 'candidateCount' && value === 1)) {
        notable[key] = value;
      }
    }
    evidence.resolution = notable;
  }
  const execution = toRecord(r.execution);
  if (execution.actualMode === 'cdp' || execution.fallbackReason) {
    evidence.execution = {
      actualMode: execution.actualMode,
      ...(execution.fallbackReason ? { fallbackReason: execution.fallbackReason } : {}),
    };
  }
  if (r.effects && typeof r.effects === 'object') evidence.effects = r.effects;
  return Object.fromEntries(Object.entries(evidence).filter(([, value]) => value !== undefined));
}

/** Health evidence without idle diagnostics: zero-valued recovery counters,
internal latency stats, and idle debugger/capture state are dropped, which
cuts a routine health check from ~1k tokens to ~200. */
function compactHealthEvidence(result: Record<string, unknown>): Record<string, unknown> {
  const { recovery, domBaselines, debugger: debuggerState, capture, ...rest } = result;

  const evidence: Record<string, unknown> = { ...rest };

  const activeRecovery: Record<string, Record<string, unknown>> = {};
  for (const [scope, value] of Object.entries(toRecord(recovery))) {
    const events = toRecord(toRecord(value).events);
    for (const [event, stats] of Object.entries(events)) {
      const record = toRecord(stats);
      if (record.attempts || record.pending || record.activeLoop) {
        activeRecovery[`${scope}.${event}`] = {
          attempts: record.attempts,
          failures: record.failures,
          ...(record.activeLoop ? { activeLoop: true } : {}),
        };
      }
    }
  }
  if (Object.keys(activeRecovery).length) evidence.recovery = activeRecovery;
  const baselineCount = toRecord(domBaselines).baselineCount;
  if (typeof baselineCount === 'number' && baselineCount > 0) {
    evidence.domBaselines = { baselineCount, bytes: toRecord(domBaselines).bytes };
  }
  const debuggerRecord = toRecord(debuggerState);
  if (debuggerState && (debuggerRecord.status !== 'idle' || debuggerRecord.attachedTabCount)) {
    evidence.debugger = debuggerState;
  }
  const captureRecord = toRecord(capture);
  if (capture && captureRecord.state !== 'stopped') evidence.capture = capture;
  return evidence;
}

/** One-line digest of observed post-action effects. */
function describeEffects(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const effects = value as Record<string, unknown>;

  const parts: string[] = [];
  if (effects.navigation === 'unloading') parts.push('page is navigating');
  if (typeof effects.url === 'string') parts.push(`URL → ${truncateUrl(effects.url)}`);
  for (const dialog of Array.isArray(effects.dialogs) ? effects.dialogs : []) {
    const record = toRecord(dialog);
    parts.push(
      `${record.role ?? 'dialog'}${record.name ? ` "${record.name}"` : ''} opened [${record.ref}]`
    );
  }
  for (const message of Array.isArray(effects.messages) ? effects.messages : []) {
    const record = toRecord(message);
    parts.push(`${record.role ?? 'status'}: "${record.text}"`);
  }
  const focused = toRecord(effects.focused);
  if (focused.ref)
    parts.push(
      `focus → ${focused.role ?? ''}${focused.name ? ` "${focused.name}"` : ''} [${focused.ref}]`
    );
  const dom = toRecord(effects.dom);
  if (typeof dom.added === 'number' || typeof dom.removed === 'number') {
    parts.push(`DOM +${dom.added ?? 0}/-${dom.removed ?? 0}`);
  }
  if (toRecord(effects.target).removed === true) parts.push('target removed');
  if (!parts.length) {
    if (effects.changed !== false) return '';
    // Target state is a post-action snapshot, not part of changed.
    return Object.keys(toRecord(effects.target)).length
      ? ' No additional page effect.'
      : ' No visible effect.';
  }
  return ` Effects: ${parts.join('; ')}.`;
}

const ACTION_SUMMARIES: Record<string, ActionSummary> = {
  performed: {
    text: (r) => {
      const failures = Array.isArray(r.failures) ? r.failures.length : 0;
      const lastResult = toRecord(r.lastResult);
      const finalEvidence = lastResult.truncated
        ? ' Final result omitted: size limit exceeded; inspect with a narrower read, do not replay actions.'
        : describeEffects(toRecord(lastResult.result).effects);
      return `Performed ${r.completed ?? 0}/${r.total ?? 0} step(s) in ${r.elapsedMs ?? 0}ms${failures ? ` with ${failures} failed step(s)` : ''}.${finalEvidence}`;
    },
    evidence: (r) => r,
  },
  touched: {
    text: (r) => {
      const mode = toRecord(r.execution).actualMode;
      return `Touched ${r.pointCount ?? 0} point(s)${typeof mode === 'string' ? ` via ${mode}` : ''}.`;
    },
    evidence: (r) => r,
  },
  hovered: {
    text: (r) =>
      `Hover ${r.hovered ? 'active' : 'failed'} on ${r.elementRef}.${describeEffects(r.effects)}`,
    evidence: (r) => compactInputEvidence(r),
  },
  dragged: {
    text: (r) =>
      `Drag ${r.dragged ? 'completed' : 'failed'}: ${r.sourceRef} → ${r.destinationRef}.`,
    evidence: (r) => r,
  },
  closed: { text: (r) => `Tab ${r.tabId} closed.`, evidence: (r) => r },
  clicked: {
    text: (r) => {
      const mode = toRecord(r.execution).actualMode;
      return `Clicked ${r.elementRef ?? 'element'}${typeof mode === 'string' ? ` via ${mode}` : ''}.${describeEffects(r.effects)}`;
    },
    evidence: (r) => compactInputEvidence(r),
  },
  focused: {
    text: (r) => `Focused ${r.elementRef ?? 'element'}.${describeEffects(r.effects)}`,
    evidence: (r) => compactInputEvidence(r),
  },
  typed: {
    text: (r) => `Typed into ${r.elementRef ?? 'element'}.${describeEffects(r.effects)}`,
    evidence: (r) => compactInputEvidence(r, { value: r.value }),
  },
  pressed: {
    text: (r) => `Key pressed${r.key ? ` (${r.key})` : ''}.${describeEffects(r.effects)}`,
    evidence: (r) => {
      const { resolution: _resolution, execution: _execution, effects: _effects, ...rest } = r;
      const { elementRef: _elementRef, ...compact } = compactInputEvidence(r);
      return { ...rest, ...compact };
    },
  },
  navigated: {
    text: (r) => `Navigated to ${r.url ?? 'page'}.`,
    evidence: (r) => ({ url: r.url }),
  },
  scrolled: {
    text: (r) => `Scrolled to (${r.x ?? 0}, ${r.y ?? 0}).`,
    evidence: (r) => r,
  },
  resized: {
    text: (r) => `Viewport resized to ${r.width ?? '?'}×${r.height ?? '?'}.`,
    evidence: (r) => r,
  },
};

export function summarizeBridgeResponse(response: BridgeResponse, method?: string): BridgeSummary {
  const summarized = summarizeBridgeResponseBody(response, method);
  const routingNote = response.ok ? getTabRoutingNote(response.meta) : null;
  return routingNote
    ? { ...summarized, summary: `${summarized.summary} ${routingNote}` }
    : summarized;
}

function summarizeBridgeResponseBody(response: BridgeResponse, method?: string): BridgeSummary {
  const protocolWarning = getProtocolWarning(response.meta);
  if (!response.ok) {
    const recovery = response.error.recovery ?? getErrorRecovery(response.error.code);
    return {
      ok: false,
      summary: appendProtocolWarning(
        `${response.error.code}: ${response.error.message}${recovery?.hint ? ` ${recovery.hint}` : ''}`,
        protocolWarning
      ),
      evidence: response.error.details ?? null,
      recovery,
    };
  }

  const result = toRecord(response.result);
  if (method === 'input.perform' && result.verified === true) {
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Sequence completed ${result.completed ?? 0}/${result.total ?? 0} steps; verified ${Array.isArray(result.outcomes) ? result.outcomes.length : 0} outcome(s).`,
        protocolWarning
      ),
      evidence: result,
    };
  }
  if (method === 'dom.get_attributes') {
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Read ${Object.keys(result).length} attribute(s).`,
        protocolWarning
      ),
      evidence: result,
    };
  }
  if (method?.startsWith('screenshot.baseline.')) {
    const evidence = { ...result };
    delete evidence.image;
    if (Array.isArray(result.images))
      evidence.images = result.images.map((image) => {
        const entry = toRecord(image);
        return { phase: entry.phase, rect: entry.rect };
      });
    return {
      ok: true,
      summary: appendProtocolWarning(
        method === 'screenshot.baseline.compare'
          ? `Visual comparison: ${result.reason ?? 'unknown'}. ${result.guidance ?? ''}`
          : `Visual baseline ${result.baselineId ?? ''}.`,
        protocolWarning
      ),
      evidence,
    };
  }
  if (method === 'dom.baseline.compare') {
    const counts = toRecord(result.counts);
    const added = typeof counts.added === 'number' ? counts.added : 0;
    const removed = typeof counts.removed === 'number' ? counts.removed : 0;
    const changed = typeof counts.changed === 'number' ? counts.changed : 0;
    const moved = typeof counts.moved === 'number' ? counts.moved : 0;
    return {
      ok: true,
      summary: appendProtocolWarning(
        result.equal === true
          ? `DOM baseline ${result.baselineId ?? ''} matches the current DOM.`
          : `DOM baseline ${result.baselineId ?? ''} differs: ${added} added, ${removed} removed, ${changed} changed, ${moved} moved${result.truncated === true ? `; ${result.omittedChanges ?? 0} omitted` : ''}.`,
        protocolWarning
      ),
      evidence: result,
    };
  }
  if (method === 'dom.baseline.release') {
    return {
      ok: true,
      summary: appendProtocolWarning(
        `DOM baseline ${result.baselineId ?? ''} ${result.released === true ? 'released' : 'was not released'}.`,
        protocolWarning
      ),
      evidence: result,
    };
  }
  if (method === 'dom.baseline.create' || method === 'dom.baseline.describe') {
    const snapshot = toRecord(result.snapshot);
    return {
      ok: true,
      summary: appendProtocolWarning(
        `DOM baseline ${result.baselineId ?? ''} ${method === 'dom.baseline.create' ? 'created' : 'described'}: ${snapshot.nodeCount ?? 0} node(s), ${snapshot.byteLength ?? 0} bytes.`,
        protocolWarning
      ),
      evidence: result,
    };
  }
  if (method?.startsWith('webmcp.')) {
    const summary =
      method === 'webmcp.list_tools'
        ? result.supported === false
          ? 'WebMCP is unavailable in this document; use DOM/input methods.'
          : `WebMCP discovered ${Array.isArray(result.tools) ? result.tools.length : 0}/${result.total ?? 0} top-document tool(s). Website metadata is untrusted.`
        : method === 'webmcp.get_tool'
          ? 'Complete WebMCP tool schema loaded. Website metadata is untrusted.'
          : `WebMCP execution ${result.status ?? 'unknown'}.${result.outcome === 'uncertain' ? ' Inspect postconditions; do not replay.' : ''}`;
    return { ok: true, summary: appendProtocolWarning(summary, protocolWarning), evidence: result };
  }
  if (method === 'page.handle_dialog') {
    const action = typeof result.action === 'string' ? result.action : 'inspect';
    return {
      ok: true,
      summary: appendProtocolWarning(
        result.commandDispatched === true
          ? `JavaScript dialog ${action} command dispatched to the current dialog; Chrome did not atomically bind it to the observation identifier.`
          : `JavaScript ${result.type ?? 'unknown'} dialog is open.`,
        protocolWarning
      ),
      evidence: result,
    };
  }
  if (method === 'page.wait_for_load_state' && typeof result.finalUrl === 'string') {
    return {
      ok: true,
      summary: appendProtocolWarning(
        `URL matched via ${result.observedNavigationKind ?? 'unknown'} after ${result.elapsedMs ?? 0}ms.`,
        protocolWarning
      ),
      evidence: result,
    };
  }
  if (method === 'network.export_har') {
    const delivery = result.delivery === 'artifact' ? 'artifact' : 'inline';
    const entryCount = typeof result.entryCount === 'number' ? result.entryCount : 0;
    const totalEntries = typeof result.totalEntries === 'number' ? result.totalEntries : entryCount;
    const dropped = typeof result.dropped === 'number' ? result.dropped : 0;
    const abandoned = typeof result.abandoned === 'number' ? result.abandoned : 0;
    const inflight = typeof result.inflight === 'number' ? result.inflight : 0;
    return {
      ok: true,
      summary: appendProtocolWarning(
        `HAR export delivered ${delivery}: ${entryCount}/${totalEntries} entries (${dropped} dropped, ${abandoned} abandoned, ${inflight} inflight).`,
        protocolWarning
      ),
      evidence: {
        delivery,
        entryCount,
        totalEntries,
        dropped,
        abandoned,
        inflight,
      } as import('./types.js').HarExportEvidence,
    };
  }
  if (method?.startsWith('emulation.')) {
    return {
      ok: true,
      summary: `Emulation ${result.active ? 'active' : 'inactive'}; ${Array.isArray(result.pendingReset) ? result.pendingReset.length : 0} setting(s) retained.`,
      evidence: result,
    };
  }
  if (method === 'input.set_files') {
    return {
      ok: true,
      summary: `File input ${result.assigned ? 'assigned' : 'not verified'}: ${result.count ?? 0} file(s).`,
      evidence: result,
    };
  }
  if (method?.startsWith('files.')) {
    return {
      ok: true,
      summary: result.released
        ? 'Staged file released.'
        : `File staged: ${result.nextOffset ?? 0}/${result.size ?? 0} bytes.`,
      evidence: result,
    };
  }
  if (method === 'download.resource') {
    return { ok: true, summary: 'Resource downloaded to a chunked artifact.', evidence: result };
  }
  if (method?.startsWith('download.')) {
    return {
      ok: true,
      summary: result.released
        ? 'Browser download handle released.'
        : `Browser download ${result.state ?? 'updated'}: ${result.bytesReceived ?? 0}/${result.totalBytes ?? -1} bytes.`,
      evidence: result,
    };
  }
  if (method === 'input.paste_image') {
    return {
      ok: true,
      summary: 'Native image paste dispatched. Verify insertion in the editor.',
      evidence: result,
    };
  }
  if (method?.startsWith('session.')) {
    return {
      ok: true,
      summary: `Recording ${result.sessionId ?? ''}: ${result.released ? 'released' : result.delivery === 'artifact' ? 'exported' : result.active ? 'active' : 'stopped'}; ${result.gaps ?? 0} gap(s).`,
      evidence: result,
    };
  }
  if (typeof result.daemon === 'string') {
    const access =
      result.access && typeof result.access === 'object'
        ? (result.access as Record<string, unknown>)
        : null;
    const accessSummary =
      access == null
        ? ''
        : access.enabled
          ? ` Access: ${access.routeReady ? `ready on tab ${access.routeTabId}.` : `enabled${typeof access.reason === 'string' ? ` (${access.reason})` : '.'}`}${typeof access.workingTabId === 'number' && access.workingTabId !== access.routeTabId ? ` Your working tab is ${access.workingTabId}.` : ''}`
          : ' Access: disabled.';
    const connectedExtensions = Array.isArray(result.connectedExtensions)
      ? (result.connectedExtensions as Array<Record<string, unknown>>)
      : [];
    const extensionSummary = result.extensionConnected
      ? `connected (${connectedExtensions.length}: ${connectedExtensions
          .map((ext) => {
            const label = `${ext.browserName ?? 'unknown'}${ext.profileLabel ? '/' + ext.profileLabel : ''}`;
            return ext.accessEnabled ? `${label}*` : label;
          })
          .join(', ')})`
      : 'disconnected';
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Daemon: ${result.daemon}. Extension: ${extensionSummary}.${accessSummary}`,
        protocolWarning
      ),
      evidence: compactHealthEvidence(result),
    };
  }
  if (Array.isArray(result.mcpClients) && Array.isArray(result.skillTargets)) {
    const configuredMcp = result.mcpClients.filter(
      (entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).configured
    ).length;
    const installedSkills = result.skillTargets.filter(
      (entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).installed
    ).length;
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Setup: MCP configured for ${configuredMcp}/${result.mcpClients.length} clients; skill installed for ${installedSkills}/${result.skillTargets.length} targets.`,
        protocolWarning
      ),
      evidence: result,
    };
  }
  if (typeof result.content === 'string' && typeof result.source === 'string') {
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Extracted ${result.source} ${result.format ?? 'text'}: ${result.length ?? result.content.length} chars${result.truncated ? ' (truncated)' : ''}.`,
        protocolWarning
      ),
      evidence: {
        content: result.content.slice(0, 500),
        format: result.format,
        source: result.source,
        length: result.length,
        truncated: result.truncated,
        settlement: result.settlement,
      },
    };
  }
  if (
    typeof result.url === 'string' &&
    typeof result.title === 'string' &&
    typeof result.origin === 'string'
  ) {
    const hints: string[] = [];
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
      evidence: {
        url: result.url,
        origin: result.origin,
        title: result.title,
        hints: result.hints,
        ...(result.scroll && typeof result.scroll === 'object' ? { scroll: result.scroll } : {}),
        ...(result.viewport && typeof result.viewport === 'object'
          ? { viewport: result.viewport }
          : {}),
      },
    };
  }
  if (
    (typeof result.text === 'string' || typeof result.value === 'string') &&
    typeof result.truncated === 'boolean'
  ) {
    const text = (result.text ?? result.value) as string;
    const len = typeof result.length === 'number' ? result.length : text.length;
    const count = text.length < len ? `${text.length}/${len}` : String(len);
    const label = method === 'dom.get_text' ? 'Element text' : 'Page text';
    return {
      ok: true,
      summary: appendProtocolWarning(
        `${label}: ${count} chars${result.truncated ? ' (truncated)' : ''}.`,
        protocolWarning
      ),
      evidence: {
        text: text.slice(0, 500),
        length: len,
        truncated: result.truncated,
      },
    };
  }
  if (Array.isArray(result.tabs)) {
    const tabs = result.tabs as TabResult[];
    const page = result.pagination
      ? { tabs, pagination: result.pagination as import('./types.js').TabPagination }
      : paginateTabList(tabs, { limit: 30 });
    return {
      ok: true,
      summary: appendProtocolWarning(describeTabList(page.pagination), protocolWarning),
      pagination: page.pagination,
      evidence: page.tabs.map((tab) => ({
        tabId: tab.tabId,
        active: tab.active,
        origin: tab.origin,
        title: tab.title,
      })),
    };
  }
  if (typeof result.outline === 'string') {
    const count = typeof result.count === 'number' ? result.count : 0;
    const refs = result.source === 'dom' ? '; refs work as input targets' : '';
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Accessibility outline: ${count} node(s)${result.truncated === true ? ', truncated' : ''}${refs}.`,
        protocolWarning
      ),
      evidence: result.outline,
    };
  }
  if (Array.isArray(result.nodes) && result.source === 'dom' && result.format === 'tree') {
    const nodes = result.nodes as Array<Record<string, unknown>>;
    const count = typeof result.count === 'number' ? result.count : nodes.length;
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Accessibility tree (DOM): ${count} node(s)${result.truncated === true ? ', truncated' : ''}; refs work as input targets.`,
        protocolWarning
      ),
      evidence: nodes.slice(0, 20).map((n) => {
        const entry: Record<string, unknown> = {};
        if ('ref' in n) entry.ref = n.ref;
        if ('role' in n) entry.role = n.role;
        if (n.name) entry.name = n.name;
        if (Array.isArray(n.states) && n.states.length > 0) entry.states = n.states;
        return entry;
      }),
    };
  }
  if (
    Array.isArray(result.nodes) &&
    typeof result.total === 'number' &&
    result.nodes[0]?.role !== undefined
  ) {
    const nodes = result.nodes as Array<Record<string, unknown>>;
    const interactive = nodes.filter((n: Record<string, unknown>) => n.interactive);
    const shown =
      interactive.length > 0
        ? interactive
        : nodes.filter(
            (n: Record<string, unknown>) => n.role && n.role !== 'none' && n.role !== 'generic'
          );
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Accessibility tree: ${result.count ?? nodes.length} nodes (${interactive.length} interactive)${result.truncated ? ', truncated' : ''}.`,
        protocolWarning
      ),
      evidence: shown.slice(0, 20).map((n: Record<string, unknown>) => {
        const entry: Record<string, unknown> = { role: n.role, name: n.name };
        if (n.interactive) entry.interactive = true;
        if (n.value) entry.value = n.value;
        return entry;
      }),
    };
  }
  if (Array.isArray(result.nodes)) {
    const nodes = result.nodes as Array<Record<string, unknown>>;
    const compact = nodes.slice(0, 15).map((n) => {
      const entry: Record<string, unknown> = { ref: n.elementRef, tag: n.tag };
      if (n.id) entry.id = n.id;
      if (typeof n.attrs === 'object' && n.attrs !== null) {
        const attrs = n.attrs as Record<string, unknown>;
        if (attrs.id) entry.id = attrs.id;
        if (typeof attrs.class === 'string')
          entry.cls = attrs.class.split(' ').slice(0, 3).join(' ');
        if (attrs.role) entry.role = attrs.role;
        if (attrs['aria-label']) entry.label = attrs['aria-label'];
        if (attrs['data-testid']) entry.testId = attrs['data-testid'];
      }
      if (!entry.role && n.role) entry.role = n.role;
      if (!entry.label && n.name) entry.label = n.name;
      const text =
        typeof n.textExcerpt === 'string'
          ? n.textExcerpt
          : typeof n.text === 'string'
            ? n.text
            : '';
      if (text) {
        entry.text = text.length > 80 ? `${text.slice(0, 79)}\u2026` : text;
      }
      if (Array.isArray(n.children) && n.children.length) {
        entry.childCount = n.children.length;
      }
      if (n.visible === false) entry.visible = false;
      return entry;
    });
    const isFind = method === 'dom.find_by_text' || method === 'dom.find_by_role';
    if (isFind) {
      const count = typeof result.count === 'number' ? result.count : nodes.length;
      const scanned = typeof result.scanned === 'number' ? result.scanned : null;
      const truncated = result.truncated === true;
      let summary;
      if (count === 0) {
        summary = truncated
          ? `No matching elements returned; search stopped${scanned === null ? '' : ` after scanning ${scanned}`}.`
          : 'No matching elements found.';
      } else if (truncated) {
        summary = `Found ${count} matching element(s); additional matches were omitted.`;
      } else {
        summary = `Found ${count} matching element(s)${scanned === null ? '' : ` after scanning ${scanned}`}.`;
      }
      if (typeof result.hiddenMatches === 'number' && result.hiddenMatches > 0) {
        summary += ` ${result.hiddenMatches} hidden match(es) omitted (includeHidden: true to list).`;
      }
      return {
        ok: true,
        summary: appendProtocolWarning(summary, protocolWarning),
        evidence: {
          found: count > 0,
          count,
          scanned,
          truncated,
          truncationReason: result.truncationReason ?? null,
          nodes: compact,
        },
      };
    }
    const matchCount = typeof result.matchCount === 'number' ? result.matchCount : 0;
    const matchNote =
      matchCount > 1
        ? ` The selector matched ${matchCount} elements; only the first match's subtree is shown. Narrow the selector or use dom.find_by_role or dom.find_by_text to list matches.`
        : '';
    return {
      ok: true,
      summary: appendProtocolWarning(
        `DOM query returned ${nodes.length} element(s)${nodes.length > 15 ? '; showing first 15' : ''}.${matchNote}`,
        protocolWarning
      ),
      evidence: compact,
    };
  }
  if (typeof result.rolledBack === 'boolean' || typeof result.rolled_back === 'boolean') {
    return {
      ok: true,
      summary: appendProtocolWarning('Patch rolled back.', protocolWarning),
      evidence: result,
    };
  }
  if (typeof result.patchId === 'string') {
    return {
      ok: true,
      summary: appendProtocolWarning(`Patch ${result.patchId} applied.`, protocolWarning),
      evidence: result,
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
      evidence: {
        elementRef: result.elementRef ?? null,
        duration: result.duration,
      },
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
      repr =
        result.value.length > MAX_EVALUATE_SUMMARY_CHARS
          ? `${result.value.length} chars, starts ${JSON.stringify(result.value.slice(0, EVALUATE_PREVIEW_CHARS))}\u2026`
          : result.value;
    } else if (
      typeof result.value === 'object' &&
      result.value !== null &&
      Object.keys(result.value).length === 0
    ) {
      repr = '(empty - may be a Promise, Map, or non-serializable value)';
    } else {
      repr = summarizeEvaluateValue(result.value);
    }
    const typeLabel = isNull ? 'null' : result.type;
    return {
      ok: true,
      summary: appendProtocolWarning(
        repr ? `Evaluated to ${typeLabel}: ${repr}` : `Evaluated to ${typeLabel}.`,
        protocolWarning
      ),
      evidence: result,
    };
  }
  if (
    Array.isArray(result.entries) &&
    result.entries.length > 0 &&
    typeof result.entries[0]?.at === 'string' &&
    typeof result.entries[0]?.method === 'string'
  ) {
    const entries = result.entries as Array<Record<string, unknown>>;
    return {
      ok: true,
      summary: appendProtocolWarning(`Log: ${entries.length} entries.`, protocolWarning),
      evidence: entries.slice(-10).map((e: Record<string, unknown>) => ({
        at: e.at,
        method: e.method,
        ok: e.ok,
        ...(typeof e.source === 'string' && e.source ? { source: e.source } : {}),
      })),
    };
  }
  if (
    Array.isArray(result.entries) &&
    (result.entries.length > 0
      ? result.entries[0]?.type === 'fetch' ||
        result.entries[0]?.type === 'xhr' ||
        typeof result.entries[0]?.resourceType === 'string'
      : method === 'page.get_network')
  ) {
    const entries = result.entries as Array<Record<string, unknown>>;
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Network: ${result.count ?? entries.length} requests (${result.total ?? '?'} total).`,
        protocolWarning
      ),
      evidence: entries.slice(0, 20).map((e: Record<string, unknown>) => ({
        method: e.method,
        url: truncateUrl(e.url as string),
        status: e.status,
        duration: e.duration,
        ...(typeof e.resourceType === 'string' ? { resourceType: e.resourceType } : {}),
        ...(typeof e.failureReason === 'string' && e.failureReason
          ? { failureReason: e.failureReason }
          : {}),
      })),
    };
  }
  if (
    result.exact === true &&
    typeof result.source === 'string' &&
    typeof result.value === 'string'
  ) {
    return {
      ok: true,
      summary: appendProtocolWarning('Sensitive storage value read exactly.', protocolWarning),
      evidence: { source: result.source, exact: true },
    };
  }
  if (typeof result.count === 'number' && typeof result.type === 'string' && result.entries) {
    const entries = Array.isArray(result.entries)
      ? result.entries.map((entry) => {
          const candidate =
            entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
          return {
            key: typeof candidate.key === 'string' ? candidate.key : '',
            present: candidate.present === true,
          };
        })
      : [];
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Storage (${result.type}): ${result.count} entries.`,
        protocolWarning
      ),
      evidence: {
        entries,
        total: typeof result.total === 'number' ? result.total : result.count,
        truncated: result.truncated === true,
      },
    };
  }
  if (Array.isArray(result.entries)) {
    const consoleEntries = result.entries as Array<Record<string, unknown>>;
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Console: ${result.count ?? consoleEntries.length} entries (${result.total ?? '?'} total).`,
        protocolWarning
      ),
      evidence: consoleEntries.slice(0, 20).map((e: Record<string, unknown>) => {
        const entry: Record<string, unknown> = { level: e.level, args: e.args };
        if (typeof e.ts === 'number') {
          entry.ago = formatRelativeTime(e.ts);
        }
        return entry;
      }),
    };
  }
  if (typeof result.html === 'string') {
    return {
      ok: true,
      summary: appendProtocolWarning(
        `HTML fragment: ${result.html.length} chars${result.truncated ? ' (truncated)' : ''}.`,
        protocolWarning
      ),
      evidence: {
        html: result.html.slice(0, 500),
        truncated: result.truncated,
      },
    };
  }
  for (const [field, handler] of Object.entries(ACTION_SUMMARIES)) {
    if (typeof result[field] === 'boolean') {
      return {
        ok: true,
        summary: appendProtocolWarning(handler.text(result), protocolWarning),
        evidence: handler.evidence(result),
      };
    }
  }
  if (method?.startsWith('input.') && result.execution && typeof result.execution === 'object') {
    const execution = toRecord(result.execution);
    return {
      ok: true,
      summary: appendProtocolWarning(
        `${method} completed via ${execution.actualMode ?? 'dom'}${result.elementRef ? ` on ${result.elementRef}` : ''}.${describeEffects(result.effects)}`,
        protocolWarning
      ),
      evidence: compactInputEvidence(result, {
        sourceRef: result.sourceRef ?? undefined,
        destinationRef: result.destinationRef ?? undefined,
        typed: result.typed,
        checked: result.checked,
        selectedValues: result.selectedValues,
        mode: result.mode,
        value: result.value,
      }),
    };
  }
  if (typeof result.tabId === 'number' && typeof result.url === 'string') {
    const actionMethod = typeof result.method === 'string' ? result.method : method;
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
      summary: appendProtocolWarning(describeTabResult(actionMethod, result), protocolWarning),
      evidence: result,
    };
  }
  if (typeof result.metrics === 'object' && result.metrics !== null) {
    const keys = Object.keys(result.metrics);
    const measurement = toRecord(result.measurement);
    const rawCdpCounters =
      method === 'performance.get_metrics' || measurement.kind === 'raw_cdp_counters';
    return {
      ok: true,
      summary: appendProtocolWarning(
        rawCdpCounters
          ? `Raw CDP performance counters: ${keys.length} collected in a browser-maintained point sample; Web Vitals not measured.`
          : `Performance: ${keys.length} metrics collected.`,
        protocolWarning
      ),
      evidence: rawCdpCounters ? { metrics: result.metrics, measurement } : result.metrics,
    };
  }
  if (
    typeof result.tag === 'string' &&
    typeof result.elementRef === 'string' &&
    typeof result.bbox === 'object'
  ) {
    const desc = [result.tag];
    if (result.id) desc[0] += `#${result.id}`;
    const declaredText =
      typeof result.text === 'object' && result.text !== null && 'value' in result.text
        ? (result.text as { value: string }).value
        : typeof result.text === 'string'
          ? result.text
          : '';
    // layout.hit_test returns a node summary, which names its text textExcerpt.
    const textValue =
      declaredText || (typeof result.textExcerpt === 'string' ? result.textExcerpt : '');
    if (textValue) desc.push(String(textValue).slice(0, 60));
    const bbox = result.bbox as Record<string, number>;
    if (bbox.width && bbox.height) {
      desc.push(`${bbox.width}\u00d7${bbox.height}`);
    }
    return {
      ok: true,
      summary: appendProtocolWarning(`Element ${desc.join(', ')}.`, protocolWarning),
      evidence: {
        elementRef: result.elementRef,
        tag: result.tag,
        id: result.id,
        role: result.role,
        text: textValue,
        bbox: result.bbox,
      },
    };
  }
  if (
    typeof result.properties === 'object' &&
    result.properties !== null &&
    typeof result.elementRef === 'string'
  ) {
    const props = Object.keys(result.properties as object);
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Computed ${props.length} style(s) for ${result.elementRef}.`,
        protocolWarning
      ),
      evidence: result.properties,
    };
  }
  if (method === 'styles.get_computed') {
    const props = Object.keys(result);
    return {
      ok: true,
      summary: appendProtocolWarning(`Computed ${props.length} style(s).`, protocolWarning),
      evidence: result,
    };
  }
  if (typeof result.content === 'object' && typeof result.border === 'object') {
    const c = result.content as Record<string, number>;
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Box model: ${c.width ?? '?'}×${c.height ?? '?'} at (${c.x ?? 0}, ${c.y ?? 0}).`,
        protocolWarning
      ),
      evidence: result,
    };
  }
  if (
    typeof result.x === 'number' &&
    typeof result.y === 'number' &&
    typeof result.width === 'number' &&
    typeof result.height === 'number' &&
    !(
      'clicked' in result ||
      'hovered' in result ||
      'focused' in result ||
      'resized' in result ||
      'tag' in result ||
      'elementRef' in result
    )
  ) {
    return {
      ok: true,
      summary: appendProtocolWarning(
        `Box model: ${result.width}×${result.height} at (${result.x}, ${result.y}).`,
        protocolWarning
      ),
      evidence: result,
    };
  }
  if (Array.isArray(response.result) && looksLikePatchArray(response.result, method)) {
    const patches = response.result as Array<Record<string, unknown>>;
    return {
      ok: true,
      summary: appendProtocolWarning(patchListSummary(patches.length), protocolWarning),
      evidence: patches.slice(0, 10),
    };
  }
  if (Array.isArray(result.patches)) {
    return {
      ok: true,
      summary: appendProtocolWarning(patchListSummary(result.patches.length), protocolWarning),
      evidence: result.patches.slice(0, 10),
    };
  }
  const keys = Object.keys(result);
  return {
    ok: true,
    summary: appendProtocolWarning(
      `Bridge method succeeded with ${keys.length} top-level fields.`,
      protocolWarning
    ),
    evidence: keys.slice(0, 10),
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function getProtocolWarning(meta: Record<string, unknown> | null | undefined): string | null {
  return typeof meta?.protocol_warning === 'string' && meta.protocol_warning.trim()
    ? meta.protocol_warning
    : null;
}

/** Tell the agent when it kept working in its own tab while the user looked at
a different one, so "this tab" requests can be redirected explicitly. */
function getTabRoutingNote(meta: Record<string, unknown> | null | undefined): string | null {
  if (typeof meta?.tab_id !== 'number' || typeof meta.active_tab_id !== 'number') return null;
  // A caller that passed tabId already chose the tab.
  if (meta.tab_routing === 'explicit') return null;
  return `Ran in working tab ${meta.tab_id}; the user's active tab is ${meta.active_tab_id} (pass tabId to switch).`;
}

function appendProtocolWarning(summary: string, warning: string | null): string {
  return warning ? `${summary} Protocol warning: ${warning}` : summary;
}

/** Truncate a URL to a readable length, keeping origin + pathname and trimming query strings. */
function truncateUrl(url: string): string {
  const sanitized = sanitizeIncidentalUrl(url);
  if (!sanitized || sanitized.length <= 120) return sanitized;
  try {
    const u = new URL(sanitized);
    const base = `${u.origin}${u.pathname}`;
    if (base.length > 120) return `${base.slice(0, 119)}\u2026`;
    if (u.search) return `${base}?…`;
    return base;
  } catch {
    return sanitized.length > 120 ? `${sanitized.slice(0, 119)}\u2026` : sanitized;
  }
}

function patchListSummary(total: number): string {
  return total > 10 ? `${total} active patch(es); showing first 10.` : `${total} active patch(es).`;
}

/** Check if an array looks like a list of patch entries.
Returns true for empty arrays when method context suggests patch.list. */
function looksLikePatchArray(arr: unknown[], method?: string): boolean {
  if (!Array.isArray(arr)) return false;
  if (arr.length === 0) return method === 'patch.list';
  const first = arr[0];
  return first !== null && typeof first === 'object' && 'patchId' in first && 'kind' in first;
}

/** Format a Unix-ms timestamp as a human-readable relative time (e.g., "2m ago", "just now"). */
function formatRelativeTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 0) return 'just now';
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
