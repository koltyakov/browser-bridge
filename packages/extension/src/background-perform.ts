import {
  BridgeError,
  createFailure,
  createSuccess,
  ERROR_CODES,
  getUtf8ByteLength,
  MAX_PERFORM_RESULT_BYTES,
  normalizeInputPerformParams,
  normalizeWaitForLoadStateParams,
  serializeJsonPayload,
} from '../../../protocol/src/index.js';
import { requestLifetimes } from './background-request-lifetime.js';
import { armPerformOutcomes } from './background-outcomes.js';

export type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
export type BridgeResponse = import('../../../protocol/src/types.js').BridgeResponse;
export type ErrorCode = import('../../../protocol/src/types.js').ErrorCode;
export type NormalizedPerformStep = import('../../../protocol/src/types.js').NormalizedPerformStep;
export type PerformResult = import('../../../protocol/src/types.js').PerformResult;
export type PerformStepFailure = import('../../../protocol/src/types.js').PerformStepFailure;
export type PerformLastResult = import('../../../protocol/src/types.js').PerformLastResult;

export type PerformDependencies = {
  captureAccess?: () => () => void;
  resolveRequestTarget: (request: BridgeRequest) => Promise<{ tabId: number }>;
  dispatch: (request: BridgeRequest) => Promise<BridgeResponse>;
  /** Current tab load status, used to settle navigation an action started. */
  getTabStatus?: (tabId: number) => Promise<string | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} & Pick<import('./background-outcomes.js').OutcomeDependencies, 'armNetwork' | 'readNetwork'>;

/** Leave room for the failure, with progress, to reach the daemon before its
 * own timer answers the caller without it. */
const PERFORM_REPLY_MARGIN_MS = 500;

/** Step methods whose own timeoutMs is capped by the remaining sequence budget. */
const WAITING_STEP_METHODS = new Set(['dom.wait_for', 'page.wait_for_load_state']);

/** Steps that can start a navigation, such as a form submission. */
const ACTION_STEP_METHODS = new Set([
  'input.click',
  'input.press_key',
  'input.fill',
  'input.type',
  'input.select_option',
  'input.set_checked',
  'input.touch',
  'navigation.navigate',
]);

/** Read-only steps that would otherwise observe the document an action is
leaving. They are safe to repeat on the next document. */
/** Actions that commonly start a navigation (links, submit buttons, Enter). */
const NAVIGATING_STEP_METHODS = new Set(['input.click', 'input.press_key']);
/** Pause before re-reading tab status after such an action. */
const NAVIGATION_ARMING_MS = 120;

const READ_STEP_METHODS = new Set([
  'page.get_state',
  'page.get_text',
  'dom.query',
  'dom.get_text',
  'dom.wait_for',
  'dom.get_accessibility_tree',
]);

/** Failures after an action that mean the next document is not ready yet.
Reads retry on any of them. An action retries only when its target was not
found, which means it was never dispatched and cannot repeat an effect. */
const SETTLE_RETRY_CODES = new Set<string>([
  ERROR_CODES.ELEMENT_NOT_FOUND,
  ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE,
  ERROR_CODES.ELEMENT_STALE,
]);

/** How long a step after an action keeps waiting for its target. */
const SETTLE_WAIT_MS = 5_000;
const SETTLE_POLL_MS = 150;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run an input.perform sequence inside the extension so step timing does not
depend on agent round-trips. Steps run strictly in order against the tab
resolved once at the start. A step with atMs starts no earlier than that
offset from the sequence start (no drift across steps); a step with delayMs
starts that long after the previous step finished. */
export async function executeInputPerform(
  request: BridgeRequest,
  dependencies: PerformDependencies
): Promise<BridgeResponse> {
  const assertGrant = dependencies.captureAccess?.() ?? (() => {});
  const assertActive = requestLifetimes.guard(request.id);
  const assertAccess = () => {
    assertActive();
    assertGrant();
  };
  const params = normalizeInputPerformParams(request.params);
  const target = await dependencies.resolveRequestTarget(request);
  const now = dependencies.now ?? (() => performance.now());
  const sleep = dependencies.sleep ?? defaultSleep;
  const startedAt = now();
  // Time spent queued behind other mutations on this tab is part of the
  // request deadline, so the sequence cannot keep its full timeoutMs.
  const requestDeadline = request.meta?.deadline_ms;
  const lifetimeMs =
    typeof requestDeadline === 'number' && Number.isFinite(requestDeadline)
      ? requestDeadline - Date.now() - PERFORM_REPLY_MARGIN_MS
      : Infinity;
  const budgetMs = Math.min(params.timeoutMs, lifetimeMs);
  const limitedByRequest = budgetMs < params.timeoutMs;
  const deadline = startedAt + budgetMs;
  const total = params.steps.length;

  const startedAtMs: number[] = [];

  const failures: PerformStepFailure[] = [];

  let lastResult: PerformLastResult | undefined;
  let lastCompletedResult: PerformLastResult | undefined;

  const fail = (
    code: ErrorCode,
    message: string,
    failedStep: PerformStepFailure | null,
    details: Record<string, unknown> = {}
  ): BridgeResponse => {
    const response = createFailure(
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
        ...(lastCompletedResult ? { lastResult: lastCompletedResult } : {}),
        ...details,
      },
      { method: request.method }
    );
    if (startedAtMs.length && response.error) {
      const alternativeMethod = response.error.recovery?.alternativeMethod;
      response.error.recovery = {
        retry: false,
        ...(alternativeMethod ? { alternativeMethod } : {}),
        hint: 'Sequence steps may already have changed the page. Inspect partial progress and current state; do not replay input.perform automatically.',
      };
    }
    return response;
  };

  if (budgetMs <= 0)
    return fail(
      ERROR_CODES.TIMEOUT,
      'The request deadline elapsed while this sequence was queued. No steps ran.',
      null,
      { dispatched: false }
    );

  const monitor = params.outcomes
    ? await armPerformOutcomes(
        request,
        target.tabId,
        params.outcomes,
        Math.max(0, deadline - now()),
        dependencies
      )
    : null;
  try {
    for (const [index, step] of params.steps.entries()) {
      const timeout = () =>
        fail(
          ERROR_CODES.TIMEOUT,
          limitedByRequest
            ? `The request deadline left ${Math.round(budgetMs)}ms of sequence timeoutMs (${params.timeoutMs}) after queueing; it elapsed before step ${index} (${step.method}).`
            : `Sequence timeoutMs (${params.timeoutMs}) elapsed before step ${index} (${step.method}).`,
          null
        );
      const scheduledAt = step.atMs !== null ? startedAt + step.atMs : now() + step.delayMs;
      if (now() >= deadline || scheduledAt >= deadline) return timeout();
      const waitMs = scheduledAt - now();
      if (waitMs > 0) await sleep(waitMs);
      const stepStartedAt = now();
      // Timers can resume late after worker suspension or a busy event loop.
      if (stepStartedAt >= deadline) return timeout();
      try {
        assertAccess();
      } catch (error) {
        if (error instanceof BridgeError) return fail(error.code, error.message, null);
        throw error;
      }
      startedAtMs.push(Math.round(stepStartedAt - startedAt));

      const dispatchStep = (method: string, stepParams: Record<string, unknown>, suffix = '') => {
        const startedMs = now();
        return dependencies.dispatch({
          id: `${request.id}#${index}${suffix}`,
          method: method as BridgeRequest['method'],
          tab_id: target.tabId,
          params: stepParams,
          meta: {
            ...request.meta,
            deadline_ms: Math.min(
              typeof request.meta?.deadline_ms === 'number' ? request.meta.deadline_ms : Infinity,
              Date.now() + Math.max(0, deadline - startedMs)
            ),
          },
        });
      };
      const followsAction = index > 0 && ACTION_STEP_METHODS.has(params.steps[index - 1].method);
      // A read right after an action that started a navigation, such as a
      // submit click, must observe the next document rather than the old one.
      const settleNavigation = async (): Promise<boolean> => {
        if (!dependencies.getTabStatus) return false;
        let status = await dependencies.getTabStatus(target.tabId).catch(() => undefined);
        // A submit's navigation can start a few milliseconds after the click
        // returns, while the old document still reads complete. Look again.
        if (status !== 'loading' && NAVIGATING_STEP_METHODS.has(params.steps[index - 1].method)) {
          await new Promise((resolve) => setTimeout(resolve, NAVIGATION_ARMING_MS));
          status = await dependencies.getTabStatus(target.tabId).catch(() => undefined);
        }
        if (status !== 'loading') return false;
        await dispatchStep(
          'page.wait_for_load_state',
          { ...normalizeWaitForLoadStateParams({ timeoutMs: Math.max(500, deadline - now()) }) },
          ':load'
        );
        return true;
      };
      if (followsAction && READ_STEP_METHODS.has(step.method)) await settleNavigation();

      let response = await dispatchStep(
        step.method,
        capStepTimeout(step, deadline - stepStartedAt)
      );
      let failure = getStepFailure(response, step, index);
      if (failure && followsAction && SETTLE_RETRY_CODES.has(failure.code)) {
        if (READ_STEP_METHODS.has(step.method)) {
          // Reads do not auto-wait for their target: poll briefly, settling
          // any navigation first.
          const settleUntil = Math.min(deadline, now() + SETTLE_WAIT_MS);
          let attempt = 0;
          while (failure && SETTLE_RETRY_CODES.has(failure.code) && now() < settleUntil) {
            if (!(await settleNavigation())) await sleep(SETTLE_POLL_MS);
            attempt += 1;
            response = await dispatchStep(
              step.method,
              capStepTimeout(step, deadline - now()),
              `:retry${attempt}`
            );
            failure = getStepFailure(response, step, index);
          }
        } else if (failure.code === ERROR_CODES.ELEMENT_NOT_FOUND && (await settleNavigation())) {
          // An action target already waited; retry once only on the document
          // the previous action navigated to. It was never dispatched.
          response = await dispatchStep(
            step.method,
            capStepTimeout(step, deadline - now()),
            ':retry1'
          );
          failure = getStepFailure(response, step, index);
        }
      }
      if (!failure) {
        if (params.returnLastResult) {
          const byteLength = getUtf8ByteLength(serializeJsonPayload(response.result));
          lastCompletedResult =
            byteLength <= MAX_PERFORM_RESULT_BYTES
              ? {
                  index,
                  method: step.method,
                  byteLength,
                  truncated: false,
                  result: response.result,
                }
              : {
                  index,
                  method: step.method,
                  byteLength,
                  truncated: true,
                  maxBytes: MAX_PERFORM_RESULT_BYTES,
                };
          if (index === total - 1) lastResult = lastCompletedResult;
        }
        continue;
      }
      if (!params.continueOnError || failure.code === ERROR_CODES.DIALOG_BLOCKED) {
        return fail(
          failure.code as ErrorCode,
          `Step ${index} (${step.method}) failed: ${failure.message}`,
          failure
        );
      }
      failures.push(failure);
    }

    const outcomes = monitor ? await monitor.complete() : undefined;
    try {
      assertAccess();
    } catch (error) {
      if (error instanceof BridgeError) {
        return fail(error.code, error.message, null, {
          ...(outcomes ? { verified: false, outcomes, outcomeUncertain: true } : {}),
        });
      }
      throw error;
    }
    if (outcomes?.some((outcome) => outcome.status !== 'matched')) {
      return fail(
        ERROR_CODES.OUTCOME_NOT_MET,
        'Sequence steps ran, but the expected outcomes were not all verified. Inspect evidence before another action.',
        null,
        {
          verified: false,
          outcomes,
          outcomeUncertain: outcomes.some(
            (outcome) => outcome.status === 'timeout' || outcome.status === 'interrupted'
          ),
        }
      );
    }

    const result: PerformResult = {
      performed: true,
      completed: startedAtMs.length,
      total,
      elapsedMs: Math.round(now() - startedAt),
      startedAtMs,
      failures,
      ...(lastResult ? { lastResult } : {}),
      ...(outcomes ? { verified: true, outcomes } : {}),
    };
    return createSuccess(request.id, result, { method: request.method });
  } finally {
    monitor?.stop();
  }
}

/** Keep waiting steps inside the remaining sequence budget. */
function capStepTimeout(step: NormalizedPerformStep, remainingMs: number): Record<string, unknown> {
  if (!WAITING_STEP_METHODS.has(step.method)) return step.params;
  const own = Number(step.params.timeoutMs);
  const remaining = Math.max(100, Math.floor(remainingMs));
  return {
    ...step.params,
    timeoutMs: Number.isFinite(own) && own > 0 ? Math.min(own, remaining) : remaining,
  };
}

/** A step fails on an error response, or when dom.wait_for reports that its
condition never appeared: later steps usually depend on that condition. */
function getStepFailure(
  response: BridgeResponse,
  step: NormalizedPerformStep,
  index: number
): PerformStepFailure | null {
  if (!response.ok) {
    return {
      index,
      method: step.method,
      code: response.error.code,
      message: response.error.message,
      ...(response.error.details != null ? { details: response.error.details } : {}),
    };
  }
  const result =
    response.result && typeof response.result === 'object'
      ? (response.result as Record<string, unknown>)
      : null;
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
