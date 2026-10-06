// @ts-check

import {
  createFailure,
  createSuccess,
  ERROR_CODES,
  normalizeInputPerformParams,
} from '../../protocol/src/index.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('../../protocol/src/types.js').BridgeResponse} BridgeResponse */
/** @typedef {import('../../protocol/src/types.js').ErrorCode} ErrorCode */
/** @typedef {import('../../protocol/src/types.js').NormalizedPerformStep} NormalizedPerformStep */
/** @typedef {import('../../protocol/src/types.js').PerformResult} PerformResult */
/** @typedef {import('../../protocol/src/types.js').PerformStepFailure} PerformStepFailure */

/**
 * @typedef {{
 *   resolveRequestTarget: (request: BridgeRequest) => Promise<{ tabId: number }>,
 *   dispatch: (request: BridgeRequest) => Promise<BridgeResponse>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} PerformDependencies
 */

/** Step methods whose own timeoutMs is capped by the remaining sequence budget. */
const WAITING_STEP_METHODS = new Set(['dom.wait_for', 'page.wait_for_load_state']);

/** @param {number} ms @returns {Promise<void>} */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an input.perform sequence inside the extension so step timing does not
 * depend on agent round-trips. Steps run strictly in order against the tab
 * resolved once at the start. A step with atMs starts no earlier than that
 * offset from the sequence start (no drift across steps); a step with delayMs
 * starts that long after the previous step finished.
 *
 * @param {BridgeRequest} request
 * @param {PerformDependencies} dependencies
 * @returns {Promise<BridgeResponse>}
 */
export async function executeInputPerform(request, dependencies) {
  const params = normalizeInputPerformParams(request.params);
  const target = await dependencies.resolveRequestTarget(request);
  const now = dependencies.now ?? (() => performance.now());
  const sleep = dependencies.sleep ?? defaultSleep;
  const startedAt = now();
  const deadline = startedAt + params.timeoutMs;
  const total = params.steps.length;
  /** @type {number[]} */
  const startedAtMs = [];
  /** @type {PerformStepFailure[]} */
  const failures = [];

  /**
   * @param {ErrorCode} code
   * @param {string} message
   * @param {PerformStepFailure | null} failedStep
   * @returns {BridgeResponse}
   */
  const fail = (code, message, failedStep) =>
    createFailure(
      request.id,
      code,
      message,
      {
        completed: startedAtMs.length - (failedStep ? 1 : 0),
        total,
        elapsedMs: Math.round(now() - startedAt),
        startedAtMs,
        ...(failedStep ? { failedStep } : {}),
        ...(failures.length ? { failures } : {}),
      },
      { method: request.method }
    );

  for (const [index, step] of params.steps.entries()) {
    const scheduledAt = step.atMs !== null ? startedAt + step.atMs : now() + step.delayMs;
    if (scheduledAt >= deadline) {
      return fail(
        ERROR_CODES.TIMEOUT,
        `Sequence timeoutMs (${params.timeoutMs}) elapsed before step ${index} (${step.method}).`,
        null
      );
    }
    const waitMs = scheduledAt - now();
    if (waitMs > 0) await sleep(waitMs);
    const stepStartedAt = now();
    startedAtMs.push(Math.round(stepStartedAt - startedAt));

    const response = await dependencies.dispatch({
      id: `${request.id}#${index}`,
      method: step.method,
      tab_id: target.tabId,
      params: capStepTimeout(step, deadline - stepStartedAt),
      meta: request.meta,
    });
    const failure = getStepFailure(response, step, index);
    if (!failure) continue;
    if (!params.continueOnError) {
      return fail(
        /** @type {ErrorCode} */ (failure.code),
        `Step ${index} (${step.method}) failed: ${failure.message}`,
        failure
      );
    }
    failures.push(failure);
  }

  /** @type {PerformResult} */
  const result = {
    performed: true,
    completed: startedAtMs.length,
    total,
    elapsedMs: Math.round(now() - startedAt),
    startedAtMs,
    failures,
  };
  return createSuccess(request.id, result, { method: request.method });
}

/**
 * Keep waiting steps inside the remaining sequence budget.
 *
 * @param {NormalizedPerformStep} step
 * @param {number} remainingMs
 * @returns {Record<string, unknown>}
 */
function capStepTimeout(step, remainingMs) {
  if (!WAITING_STEP_METHODS.has(step.method)) return step.params;
  const own = Number(step.params.timeoutMs);
  const remaining = Math.max(100, Math.floor(remainingMs));
  return {
    ...step.params,
    timeoutMs: Number.isFinite(own) && own > 0 ? Math.min(own, remaining) : remaining,
  };
}

/**
 * A step fails on an error response, or when dom.wait_for reports that its
 * condition never appeared: later steps usually depend on that condition.
 *
 * @param {BridgeResponse} response
 * @param {NormalizedPerformStep} step
 * @param {number} index
 * @returns {PerformStepFailure | null}
 */
function getStepFailure(response, step, index) {
  if (!response.ok) {
    return {
      index,
      method: step.method,
      code: response.error.code,
      message: response.error.message,
      ...(response.error.details != null ? { details: response.error.details } : {}),
    };
  }
  const result = /** @type {Record<string, unknown> | null} */ (
    response.result && typeof response.result === 'object' ? response.result : null
  );
  if (step.method === 'dom.wait_for' && result?.found === false) {
    return {
      index,
      method: step.method,
      code: ERROR_CODES.TIMEOUT,
      message: `Condition not met within ${String(result.duration ?? step.params.timeoutMs)}ms.`,
    };
  }
  return null;
}
