import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeBridgeResponse,
  annotateBridgeSummary,
  PROTOCOL_VERSION,
  summarizeBatchResponseItem,
  summarizeBatchErrorItem,
} from '../src/index.js';
import { assertSummary } from '../../../tests/_helpers/protocolSummary.ts';
import {
  makeFailure as fail,
  makeMeta,
  makeSuccess as ok,
} from '../../../tests/_helpers/protocolFactories.ts';
import type { BridgeMethod, BridgeResponse } from '../src/types.js';

// --- summarizeBridgeResponse: error path ---

test('summarizes error responses with code and message', () => {
  const summary = summarizeBridgeResponse(fail('ACCESS_DENIED', 'Denied'));
  assert.equal(summary.ok, false);
  assert.match(summary.summary, /ACCESS_DENIED/);
  assert.match(summary.summary, /Denied/);
});

test('summarizes ELEMENT_STALE errors with recovery hint', () => {
  const summary = summarizeBridgeResponse(fail('ELEMENT_STALE', 'stale'));
  assert.match(summary.summary, /Re-query/);
});

test('preserves wire recovery metadata in error summaries', () => {
  const response = fail('TIMEOUT', 'Remote timeout', {
    details: { phase: 'extension' },
  });
  if (response.ok) assert.fail('Expected failure response');
  response.error.recovery = {
    retry: false,
    retryAfterMs: 4321,
    alternativeMethod: 'page.get_state',
    hint: 'Use the remote recovery contract.',
  };
  const summary = summarizeBridgeResponse(response);
  assert.match(summary.summary, /Use the remote recovery contract/);
  assert.deepEqual(summary.recovery, response.error.recovery);
  assert.deepEqual(summary.evidence, { phase: 'extension' });
});

test('summarizes RESULT_TRUNCATED errors with budget recovery hint', () => {
  const summary = summarizeBridgeResponse(fail('RESULT_TRUNCATED', 'trimmed'));
  assert.match(summary.summary, /RESULT_TRUNCATED/);
  assert.match(summary.summary, /raise the relevant budget|Narrow the query/);
});

test('annotated sensitive-read summaries never expose value size', () => {
  const summarize = (value: string) => {
    const response = ok(
      { source: 'local_storage', value, exact: true },
      { meta: { method: 'sensitive.read' } }
    );
    return annotateBridgeSummary(summarizeBridgeResponse(response, 'sensitive.read'), response);
  };
  const short = summarize('a');
  const long = summarize('a'.repeat(10_000));
  assert.equal(short.transportBytes, 0);
  assert.equal(short.transportTokens, 0);
  assert.equal(long.transportBytes, 0);
  assert.equal(long.transportTokens, 0);
});

test('includes protocol warning when present', () => {
  const resp = fail('TIMEOUT', 'slow');
  resp.meta = makeMeta({ protocol_warning: 'version mismatch' });
  const summary = summarizeBridgeResponse(resp);
  assert.match(summary.summary, /Protocol warning: version mismatch/);
});

// --- summarizeBridgeResponse: daemon/health result ---

test('summarizes daemon health check result', () => {
  const summary = summarizeBridgeResponse(
    ok({
      daemon: 'ok',
      extensionConnected: true,
      access: { enabled: true, routeReady: true, routeTabId: 7 },
    })
  );
  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Daemon: ok/);
  assert.match(summary.summary, /Extension: connected/);
  assert.match(summary.summary, /ready on tab 7/);
});

test('summarizes daemon health check with access disabled', () => {
  const summary = summarizeBridgeResponse(
    ok({
      daemon: 'ok',
      extensionConnected: true,
      access: { enabled: false },
    })
  );
  assert.match(summary.summary, /Access: disabled/);
});

test('summarizes daemon health check with access enabled but not ready', () => {
  const summary = summarizeBridgeResponse(
    ok({
      daemon: 'ok',
      extensionConnected: false,
      access: { enabled: true, routeReady: false, reason: 'waiting' },
    })
  );
  assert.match(summary.summary, /Extension: disconnected/);
  assert.match(summary.summary, /enabled/);
});

// --- summarizeBridgeResponse: setup status ---

test('summarizes setup status with mcpClients and skillTargets', () => {
  const summary = summarizeBridgeResponse(
    ok({
      mcpClients: [{ configured: true }, { configured: false }],
      skillTargets: [{ installed: true }],
    })
  );
  assert.match(summary.summary, /Setup:/);
  assert.match(summary.summary, /MCP configured for 1\/2/);
  assert.match(summary.summary, /skill installed for 1\/1/);
});

// --- summarizeBridgeResponse: page state ---

test('summarizes page state with url, title, and origin', () => {
  const summary = summarizeBridgeResponse(
    ok({
      url: 'https://example.com/page',
      title: 'Example Page',
      origin: 'https://example.com',
      hints: { hasDialog: true, hasPassword: false },
    })
  );
  assert.match(summary.summary, /Page: Example Page/);
  assert.match(summary.summary, /hasDialog/);
  assert.ok(!summary.summary.includes('hasPassword'));
});

test('summarizes dialog actions as non-atomic command dispatches', () => {
  const summary = summarizeBridgeResponse(
    ok({
      commandDispatched: true,
      action: 'dismiss',
      dialogId: 'observation-1',
      atomicDialogBinding: false,
    }),
    'page.handle_dialog'
  );
  assert.match(summary.summary, /command dispatched/);
  assert.match(summary.summary, /did not atomically bind/);
  assert.doesNotMatch(summary.summary, /handled|completed/);
});

test('summarizes DOM baseline creation and description', () => {
  const result = {
    baselineId: `baseline_${'a'.repeat(32)}`,
    createdAt: '2026-07-23T00:00:00.000Z',
    expiresAt: '2026-07-23T00:05:00.000Z',
    scope: {},
    options: {},
    snapshot: { nodeCount: 12, byteLength: 345, digest: 'digest' },
  };
  const created = summarizeBridgeResponse(ok(result), 'dom.baseline.create');
  const described = summarizeBridgeResponse(ok(result), 'dom.baseline.describe');
  assert.match(created.summary, /DOM baseline .* created: 12 node\(s\), 345 bytes/);
  assert.match(described.summary, /DOM baseline .* described: 12 node\(s\), 345 bytes/);
  assert.deepEqual(created.evidence, result);
});

test('summarizes equal, changed, and released DOM baselines', () => {
  const baselineId = `baseline_${'b'.repeat(32)}`;
  const equal = summarizeBridgeResponse(
    ok({ baselineId, equal: true, counts: {}, omittedChanges: 0 }),
    'dom.baseline.compare'
  );
  const changed = summarizeBridgeResponse(
    ok({
      baselineId,
      equal: false,
      counts: { added: 2, removed: 1, changed: 3, moved: 4 },
      truncated: true,
      omittedChanges: 5,
    }),
    'dom.baseline.compare'
  );
  const released = summarizeBridgeResponse(
    ok({ baselineId, released: true }),
    'dom.baseline.release'
  );
  assert.match(equal.summary, /matches the current DOM/);
  assert.match(changed.summary, /2 added, 1 removed, 3 changed, 4 moved; 5 omitted/);
  assert.match(released.summary, /released/);
});

// --- summarizeBridgeResponse: text result ---

test('summarizes page text result', () => {
  const summary = summarizeBridgeResponse(
    ok({
      text: 'Hello world content here',
      truncated: true,
      length: 5000,
    })
  );
  assert.match(summary.summary, /Page text: 5000 chars/);
  assert.match(summary.summary, /truncated/);
});

test('summarizes semantic content with source and format metadata', () => {
  const summary = summarizeBridgeResponse(
    ok({
      content: '# Guide',
      format: 'markdown',
      source: 'readability',
      truncated: false,
      length: 7,
    }),
    'page.extract_content'
  );
  assert.match(summary.summary, /Extracted readability markdown: 7 chars/);
  assert.deepEqual(summary.evidence, {
    content: '# Guide',
    format: 'markdown',
    source: 'readability',
    length: 7,
    truncated: false,
    settlement: undefined,
  });
});

test('summarizes element text result with dom.get_text method', () => {
  const summary = summarizeBridgeResponse(
    ok({
      value: 'element text',
      truncated: false,
      length: 12,
    }),
    'dom.get_text'
  );
  assert.match(summary.summary, /Element text:/);
});

// --- summarizeBridgeResponse: tabs list ---

test('summarizes tabs list', () => {
  const summary = summarizeBridgeResponse(
    ok({
      tabs: [
        { tabId: 1, active: true, origin: 'https://a.com', title: 'A' },
        { tabId: 2, active: false, origin: 'https://b.com', title: 'B' },
      ],
    })
  );
  assert.match(summary.summary, /Bridge listed 2 tab/);
});

// --- summarizeBridgeResponse: accessibility tree ---

test('summarizes accessibility tree with interactive nodes', () => {
  const summary = summarizeBridgeResponse(
    ok({
      nodes: [
        { role: 'button', name: 'Submit', interactive: true },
        { role: 'generic', name: '', interactive: false },
        { role: 'link', name: 'Home', interactive: true },
      ],
      total: 3,
      count: 3,
    })
  );
  assert.match(summary.summary, /Accessibility tree: 3 nodes/);
  assert.match(summary.summary, /2 interactive/);
});

// --- summarizeBridgeResponse: DOM query results ---

test('summarizes DOM query result', () => {
  const summary = summarizeBridgeResponse(
    ok({
      nodes: [
        {
          elementRef: 'el_1',
          tag: 'div',
          attrs: { id: 'main', class: 'container big wide extra' },
          textExcerpt: 'content',
          children: [1, 2],
        },
        {
          elementRef: 'el_2',
          tag: 'button',
          attrs: {
            role: 'button',
            'aria-label': 'Click me',
            'data-testid': 'btn',
          },
          textExcerpt: '',
        },
      ],
    })
  );
  assert.match(summary.summary, /DOM query returned 2 element/);
});

test('summarizes DOM find_by_text result', () => {
  const summary = summarizeBridgeResponse(
    ok({
      nodes: [{ elementRef: 'el_1', tag: 'span', attrs: {}, textExcerpt: 'found' }],
      count: 1,
      scanned: 8,
      truncated: true,
      truncationReason: 'maxResults',
    }),
    'dom.find_by_text'
  );
  assert.match(summary.summary, /Found 1 matching element/);
  assert.match(summary.summary, /additional matches/);
  assert.deepEqual(summary.evidence, {
    found: true,
    count: 1,
    scanned: 8,
    truncated: true,
    truncationReason: 'maxResults',
    nodes: [{ ref: 'el_1', tag: 'span', text: 'found' }],
  });
});

test('summarizes exhaustive empty DOM find results as no match', () => {
  const summary = summarizeBridgeResponse(
    ok({ nodes: [], count: 0, scanned: 12, truncated: false, truncationReason: null }),
    'dom.find_by_role'
  );
  assert.equal(summary.ok, true);
  assert.match(summary.summary, /No matching elements found/);
  assert.deepEqual(summary.evidence, {
    found: false,
    count: 0,
    scanned: 12,
    truncated: false,
    truncationReason: null,
    nodes: [],
  });
});

// --- summarizeBridgeResponse: patches ---

test('summarizes patch rollback result', () => {
  const summary = summarizeBridgeResponse(ok({ rolledBack: true }));
  assert.match(summary.summary, /Patch rolled back/);
});

test('summarizes patch applied result', () => {
  const summary = summarizeBridgeResponse(ok({ patchId: 'p_123' }));
  assert.match(summary.summary, /Patch p_123 applied/);
});

test('summarizes patch list as array response', () => {
  const resp = ok([{ patchId: 'p_1', kind: 'style' }]);
  const summary = summarizeBridgeResponse(resp);
  assert.match(summary.summary, /1 active patch/);
});

test('summarizes empty patch list array for patch.list method', () => {
  const resp = ok([]);
  const summary = summarizeBridgeResponse(resp, 'patch.list');
  assert.match(summary.summary, /0 active patch/);
});

test('summarizes patches field in result', () => {
  const summary = summarizeBridgeResponse(
    ok({
      patches: [{ patchId: 'p_1' }, { patchId: 'p_2' }],
    })
  );
  assert.match(summary.summary, /2 active patch/);
});

// --- summarizeBridgeResponse: wait_for result ---

test('summarizes successful wait_for result', () => {
  const summary = summarizeBridgeResponse(
    ok({
      found: true,
      elementRef: 'el_1',
      duration: 250,
    })
  );
  assert.equal(summary.ok, true);
  assert.match(summary.summary, /Element found after 250ms/);
});

test('summarizes timed out wait_for result', () => {
  const summary = summarizeBridgeResponse(
    ok({
      found: false,
      duration: 5000,
    })
  );
  assert.equal(summary.ok, false);
  assert.match(summary.summary, /Element not found/);
});

// --- summarizeBridgeResponse: evaluate result ---

test('summarizes evaluate result with string value', () => {
  const summary = summarizeBridgeResponse(
    ok({
      value: 'hello world',
      type: 'string',
    })
  );
  assert.match(summary.summary, /Evaluated to string: hello world/);
});

test('summarizes evaluate result with undefined type', () => {
  const summary = summarizeBridgeResponse(
    ok({
      value: null,
      type: 'undefined',
    })
  );
  assert.match(summary.summary, /Evaluated to undefined/);
});

test('summarizes evaluate result with null value', () => {
  const summary = summarizeBridgeResponse(
    ok({
      value: null,
      type: 'object',
    })
  );
  assert.match(summary.summary, /Evaluated to null/);
});

test('summarizes evaluate result with empty object', () => {
  const summary = summarizeBridgeResponse(
    ok({
      value: {},
      type: 'object',
    })
  );
  assert.match(summary.summary, /non-serializable/);
});

test('summarizes evaluate result with long string (truncates)', () => {
  const long = 'x'.repeat(300);
  const summary = summarizeBridgeResponse(
    ok({
      value: long,
      type: 'string',
    })
  );
  assert.ok(summary.summary.length < 300);
});

// --- summarizeBridgeResponse: log entries ---

test('summarizes log.tail entries', () => {
  const summary = summarizeBridgeResponse(
    ok({
      entries: [
        {
          at: '2024-01-01T00:00:00Z',
          method: 'dom.query',
          ok: true,
          source: 'mcp',
        },
        { at: '2024-01-01T00:00:01Z', method: 'page.evaluate', ok: false },
      ],
    })
  );
  assert.match(summary.summary, /Log: 2 entries/);
});

// --- summarizeBridgeResponse: network entries ---

test('summarizes network entries', () => {
  const summary = summarizeBridgeResponse(
    ok({
      entries: [
        {
          type: 'fetch',
          method: 'GET',
          url: 'https://example.com/api',
          status: 200,
          duration: 100,
        },
      ],
      count: 1,
      total: 5,
    })
  );
  assert.match(summary.summary, /Network: 1 request/);
});

test('summarizes empty network entries with method hint', () => {
  const summary = summarizeBridgeResponse(
    ok({
      entries: [],
      count: 0,
      total: 0,
    }),
    'page.get_network'
  );
  assert.match(summary.summary, /Network: 0 request/);
});

// --- summarizeBridgeResponse: console entries ---

test('summarizes console entries', () => {
  const summary = summarizeBridgeResponse(
    ok({
      entries: [{ level: 'error', args: ['something broke'], ts: Date.now() - 30_000 }],
      count: 1,
      total: 10,
    })
  );
  assert.match(summary.summary, /Console: 1 entries/);
});

// --- summarizeBridgeResponse: HTML fragment ---

test('summarizes HTML fragment result', () => {
  const summary = summarizeBridgeResponse(
    ok({
      html: '<div>hello</div>',
      truncated: false,
    })
  );
  assert.match(summary.summary, /HTML fragment: 16 chars/);
});

// --- summarizeBridgeResponse: action summaries ---

test('summarizes click action', () => {
  const summary = summarizeBridgeResponse(ok({ clicked: true, elementRef: 'el_1' }));
  assert.match(summary.summary, /Clicked el_1/);
});

test('summarizes input execution and resolution metadata', () => {
  const resolution = {
    strategy: 'selector-ranked',
    candidateCount: 2,
    evaluatedCount: 2,
    scrolled: true,
    hitTest: 'target',
    recovered: false,
  };
  const execution = {
    requestedMode: 'cdp',
    actualMode: 'cdp',
    fallbackReason: null,
    debuggerUsed: true,
    targetCoordinates: { x: 10, y: 20 },
  };
  const summary = summarizeBridgeResponse(
    ok({ clicked: true, elementRef: 'el_1', resolution, execution }),
    'input.click'
  );
  assert.equal(summary.summary, 'Clicked el_1 via cdp.');
  assert.deepEqual(summary.evidence, { elementRef: 'el_1', resolution, execution });
});

test('summarizes hover action', () => {
  const summary = summarizeBridgeResponse(ok({ hovered: true, elementRef: 'el_1' }));
  assert.match(summary.summary, /Hover active on el_1/);
});

test('summarizes drag action', () => {
  const summary = summarizeBridgeResponse(
    ok({ dragged: true, sourceRef: 'el_1', destinationRef: 'el_2' })
  );
  assert.match(summary.summary, /Drag completed: el_1 → el_2/);
});

test('summarizes key press action', () => {
  const summary = summarizeBridgeResponse(ok({ pressed: true, key: 'Enter' }));
  assert.match(summary.summary, /Key pressed.*Enter/);
});

test('summarizes scroll action', () => {
  const summary = summarizeBridgeResponse(ok({ scrolled: true, x: 0, y: 500 }));
  assert.match(summary.summary, /Scrolled to.*0.*500/);
});

test('summarizes resize action', () => {
  const summary = summarizeBridgeResponse(ok({ resized: true, width: 1280, height: 720 }));
  assert.match(summary.summary, /Viewport resized to 1280×720/);
});

test('summarizes tab closed action', () => {
  const summary = summarizeBridgeResponse(ok({ closed: true, tabId: 7 }));
  assert.match(summary.summary, /Tab 7 closed/);
});

test('summarizes typed action', () => {
  const summary = summarizeBridgeResponse(ok({ typed: true, elementRef: 'el_input' }));
  assert.match(summary.summary, /Typed into el_input/);
});

test('summarizes focused action', () => {
  const summary = summarizeBridgeResponse(ok({ focused: true, elementRef: 'el_input' }));
  assert.match(summary.summary, /Focused el_input/);
});

// --- summarizeBridgeResponse: tab creation ---

test('summarizes tab creation result', () => {
  const summary = summarizeBridgeResponse(ok({ tabId: 9, url: 'https://new.com' }));
  assert.match(summary.summary, /Tab 9 created.*new\.com/);
});

test('summarizes navigation.navigate result with tabId and url', () => {
  const summary = summarizeBridgeResponse(
    ok({
      tabId: 9,
      url: 'https://example.com',
      title: 'Example',
      status: 'complete',
    }),
    'navigation.navigate'
  );
  assert.match(summary.summary, /Navigated to https:\/\/example\.com/);
});

// --- summarizeBridgeResponse: performance metrics ---

test('summarizes performance metrics', () => {
  const summary = summarizeBridgeResponse(
    ok({
      metrics: { FCP: 1200, LCP: 2500 },
    })
  );
  assert.match(summary.summary, /Performance: 2 metrics/);
});

// --- summarizeBridgeResponse: storage entries ---

test('summarizes storage entries', () => {
  const summary = summarizeBridgeResponse(
    ok({
      count: 3,
      total: 4,
      type: 'local',
      entries: [
        { key: 'key1', present: true },
        { key: 'key2', present: false },
        { key: 'key3', present: true },
      ],
      truncated: true,
    })
  );
  assert.match(summary.summary, /Storage.*local.*3 entries/);
  assert.deepEqual(summary.evidence, {
    entries: [
      { key: 'key1', present: true },
      { key: 'key2', present: false },
      { key: 'key3', present: true },
    ],
    total: 4,
    truncated: true,
  });
});

test('sensitive summaries never include exact values', () => {
  const summary = summarizeBridgeResponse(
    ok({ source: 'local_storage', value: 'exact-secret-value', exact: true })
  );
  assert.match(summary.summary, /Sensitive storage value read exactly/);
  assert.deepEqual(summary.evidence, { source: 'local_storage', exact: true });
  assert.doesNotMatch(JSON.stringify(summary), /exact-secret-value/);
});

// --- summarizeBridgeResponse: element describe result ---

test('summarizes element describe result', () => {
  const summary = summarizeBridgeResponse(
    ok({
      tag: 'button',
      elementRef: 'el_1',
      id: 'submit-btn',
      bbox: { width: 100, height: 40 },
      text: { value: 'Submit' },
    })
  );
  assert.match(summary.summary, /Element button#submit-btn/);
  assert.match(summary.summary, /100×40/);
});

// --- summarizeBridgeResponse: computed styles ---

test('summarizes computed styles with elementRef', () => {
  const summary = summarizeBridgeResponse(
    ok({
      properties: { color: 'red', fontSize: '14px' },
      elementRef: 'el_1',
    })
  );
  assert.match(summary.summary, /Computed 2 style.*el_1/);
});

test('summarizes computed styles without elementRef via method hint', () => {
  const summary = summarizeBridgeResponse(
    ok({
      color: 'red',
      fontSize: '14px',
    }),
    'styles.get_computed'
  );
  assert.match(summary.summary, /Computed 2 style/);
});

// --- summarizeBridgeResponse: box model ---

test('summarizes box model result', () => {
  const summary = summarizeBridgeResponse(
    ok({
      content: { x: 10, y: 20, width: 100, height: 50 },
      border: { x: 8, y: 18, width: 104, height: 54 },
    })
  );
  assert.match(summary.summary, /Box model: 100×50/);
});

test('summarizes bare bounding rect as box model', () => {
  const summary = summarizeBridgeResponse(ok({ x: 10, y: 20, width: 200, height: 100 }));
  assert.match(summary.summary, /Box model: 200×100/);
});

// --- summarizeBridgeResponse: fallback ---

test('summarizes unknown result with field count', () => {
  const summary = summarizeBridgeResponse(ok({ foo: 1, bar: 2 }));
  assert.match(summary.summary, /2 top-level fields/);
});

test('summarizes non-object result gracefully', () => {
  const summary = summarizeBridgeResponse(ok('just a string'));
  assert.match(summary.summary, /0 top-level fields/);
});

test('summarizeBridgeResponse falls back to generic shape for unknown methods', () => {
  const summary = summarizeBridgeResponse(
    ok({ foo: 1, bar: 2 }),
    'browser.unknown' as unknown as BridgeMethod
  );

  assertSummary(summary, {
    summary: 'Bridge method succeeded with 2 top-level fields.',
    evidence: ['foo', 'bar'],
  });
});

// --- annotateBridgeSummary ---

test('annotateBridgeSummary adds transport and summary cost estimates', () => {
  const response = ok({ nodes: [{ tag: 'div' }] });
  const summary = { ok: true, summary: 'Test summary', evidence: null };
  const annotated = annotateBridgeSummary(summary, response);
  assert.ok(typeof annotated.transportBytes === 'number');
  assert.ok(typeof annotated.transportTokens === 'number');
  assert.ok(typeof annotated.summaryBytes === 'number');
  assert.ok(typeof annotated.summaryTokens === 'number');
  assert.ok(['cheap', 'moderate', 'heavy', 'extreme'].includes(annotated.transportCostClass));
  assert.ok(['cheap', 'moderate', 'heavy', 'extreme'].includes(annotated.summaryCostClass));
});

test('annotateBridgeSummary uses meta transport fields when available', () => {
  const response = ok({ nodes: [] });
  response.meta = {
    protocol_version: PROTOCOL_VERSION,
    transport_bytes: 42,
    transport_approx_tokens: 11,
    transport_cost_class: 'cheap',
  };
  const summary = { ok: true, summary: 'Test', evidence: null };
  const annotated = annotateBridgeSummary(summary, response);
  assert.equal(annotated.transportBytes, 42);
  assert.equal(annotated.transportTokens, 11);
  assert.equal(annotated.transportCostClass, 'cheap');
});

test('annotateBridgeSummary falls back to legacy meta fields', () => {
  const response = ok({ nodes: [] });
  response.meta = {
    protocol_version: PROTOCOL_VERSION,
    response_bytes: 100,
    approx_tokens: 25,
    cost_class: 'moderate',
  };
  const summary = { ok: true, summary: 'Test', evidence: null };
  const annotated = annotateBridgeSummary(summary, response);
  assert.equal(annotated.transportBytes, 100);
  assert.equal(annotated.transportTokens, 25);
  assert.equal(annotated.transportCostClass, 'moderate');
});

test('annotateBridgeSummary tolerates responses with missing meta', () => {
  const response = {
    id: 'r',
    ok: true,
    result: { ok: true },
    error: null,
  } as unknown as BridgeResponse;

  const annotated = annotateBridgeSummary(
    { ok: true, summary: 'Small summary', evidence: null },
    response
  );

  assert.equal(annotated.transportCostClass, 'cheap');
  assert.equal(annotated.summaryCostClass, 'cheap');
});

// --- summarizeBatchResponseItem ---

test('summarizeBatchResponseItem produces complete batch item', () => {
  const response = ok({ clicked: true, elementRef: 'el_1' });
  const item = summarizeBatchResponseItem({
    method: 'input.click' as unknown as BridgeMethod,
    tabId: 5,
    response,
    durationMs: 42,
  });
  assert.equal(item.method, 'input.click');
  assert.equal(item.tabId, 5);
  assert.equal(item.ok, true);
  assert.equal(item.durationMs, 42);
  assert.ok(item.approxTokens >= 0);
  assert.equal(item.error, null);
  assert.deepEqual(item.response, { clicked: true, elementRef: 'el_1' });
});

test('summarizeBatchResponseItem compact mode omits raw responses and trims metadata', () => {
  const response = ok({ value: 'x'.repeat(100_000) });
  response.meta = {
    protocol_version: PROTOCOL_VERSION,
    budget_truncated: true,
    continuation_hint: 'Retry with a larger budget.',
    private_debug_field: 'omit me',
  };
  const item = summarizeBatchResponseItem(
    {
      method: 'page.get_text',
      tabId: 5,
      response,
      durationMs: 42,
    },
    { compact: true }
  );
  assert.equal(Object.hasOwn(item, 'response'), false);
  assert.deepEqual(item.meta, {
    protocol_version: PROTOCOL_VERSION,
    budget_truncated: true,
    continuation_hint: 'Retry with a larger budget.',
  });
  assert.ok(JSON.stringify(item).length < 5_000);
});

// --- summarizeBatchErrorItem ---

test('summarizeBatchErrorItem wraps Error into batch item', () => {
  const item = summarizeBatchErrorItem({
    method: 'dom.query' as unknown as BridgeMethod,
    tabId: null,
    error: new Error('connection failed'),
    durationMs: 10,
  });
  assert.equal(item.ok, false);
  assert.equal(item.method, 'dom.query');
  assert.match(item.summary, /INTERNAL_ERROR/);
  assert.equal(item.approxTokens, 0);
  assert.equal(item.response, null);
});

test('summarizeBatchErrorItem wraps string error', () => {
  const item = summarizeBatchErrorItem({
    method: 'page.evaluate' as unknown as BridgeMethod,
    tabId: 3,
    error: 'something broke',
    durationMs: 5,
  });
  assert.equal(item.ok, false);
  assert.match(item.summary, /something broke/);
});
