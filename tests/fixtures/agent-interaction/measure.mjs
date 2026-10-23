// @ts-check

/** @typedef {import('../../../protocol/types.js').BridgeMethod} BridgeMethod */
/** @typedef {{ok: true, result: unknown, tokens: number} | {ok: false, result: null, error: {message: string, code: string}, tokens: number}} BridgeResponse */
/** @typedef {(method: BridgeMethod, params?: Record<string, unknown>) => Promise<BridgeResponse>} Call */
/** @typedef {{name: string, run: (call: Call) => Promise<unknown>, verify: (state: Record<string, unknown>, last: BridgeResponse | null) => boolean}} Scenario */

/** MCP delivers outlines as compact text; raw bridge results wrap that text.
 * @param {unknown} evidence
 * @returns {string}
 */
export function outlineText(evidence) {
  if (typeof evidence === 'string') return evidence;
  if (
    evidence &&
    typeof evidence === 'object' &&
    'outline' in evidence &&
    typeof evidence.outline === 'string'
  )
    return evidence.outline;
  return '';
}

/** Measure agent work separately from the benchmark's ground-truth read.
 * @param {Scenario} scenario
 * @param {Call} request
 * @param {() => number} [now]
 */
export async function measureScenario(scenario, request, now = () => performance.now()) {
  let calls = 0;
  let tokens = 0;
  /** @type {BridgeResponse | null} */
  let last = null;
  let actionFailed = false;
  /** @type {string | undefined} */
  let actionError;
  const started = now();
  /** @type {Call} */
  const call = async (method, params = {}) => {
    calls += 1;
    last = await request(method, params);
    tokens += last.tokens;
    actionFailed ||= !last.ok;
    if (!last.ok) actionError ??= last.error.code;
    return last;
  };
  try {
    await scenario.run(call);
  } catch (error) {
    return {
      scenario: scenario.name,
      ok: false,
      calls,
      tokens,
      ms: now() - started,
      verification: { calls: 0, tokens: 0, ms: 0 },
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const ms = now() - started;
  const verification = { calls: 1, tokens: 0, ms: 0 };
  const verifying = now();
  try {
    const response = await request('dom.get_attributes', {
      target: { selector: '#state' },
      attributes: ['data-state'],
    });
    verification.tokens = response.tokens;
    if (!response.ok) throw new Error(`Verification failed: ${response.error.code}`);
    const attributes = /** @type {Record<string, string | undefined>} */ (response.result);
    const state = /** @type {Record<string, unknown>} */ (
      JSON.parse(attributes['data-state'] ?? '{}')
    );
    const ok = !actionFailed && scenario.verify(state, last);
    verification.ms = now() - verifying;
    return {
      scenario: scenario.name,
      ok,
      calls,
      tokens,
      ms,
      verification,
      ...(!ok ? { error: actionError ?? 'Postcondition failed' } : {}),
    };
  } catch (error) {
    verification.ms = now() - verifying;
    return {
      scenario: scenario.name,
      ok: false,
      calls,
      tokens,
      ms,
      verification,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Nearest-rank percentiles across repeated, independently reset scenarios.
 * @param {number[]} samples
 * @returns {{p50: number, p95: number}}
 */
export function latencyPercentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (/** @type {number} */ fraction) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return { p50: at(0.5), p95: at(0.95) };
}
