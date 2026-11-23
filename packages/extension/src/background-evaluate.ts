import {
  BridgeError,
  createFailure,
  createSuccess,
  ERROR_CODES,
  normalizeEvaluateParams,
} from '../../../protocol/src/index.js';
import { requestLifetimes } from './background-request-lifetime.js';

export type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
export type BridgeResponse = import('../../../protocol/src/types.js').BridgeResponse;

export type ResolvedTabTarget = {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
};

export type PageEvaluateDependencies = {
  resolveRequestTarget: (
    request: BridgeRequest,
    options?: { requireScriptable?: boolean }
  ) => Promise<ResolvedTabTarget>;
  runWithDebugger: (
    tabId: number,
    operation: (debugTarget: chrome.debugger.Debuggee) => Promise<BridgeResponse>,
    options?: { timeoutMs?: number }
  ) => Promise<BridgeResponse>;
  /** Detach and reconcile CDP owners after an abandoned evaluation. */
  discardDebuggerSession?: (tabId: number) => Promise<void>;
  sendCommand: (
    target: chrome.debugger.Debuggee,
    method: string,
    params: {
      expression: string;
      returnByValue: boolean;
      awaitPromise: boolean;
      timeout: number;
      userGesture: boolean;
      generatePreview: boolean;
    }
  ) => Promise<unknown>;
};

/** Evaluate a JavaScript expression in the page's main context using the
Chrome DevTools Protocol, avoiding content-script CSP restrictions. */
export async function handlePageEvaluate(
  request: BridgeRequest,
  dependencies: PageEvaluateDependencies
): Promise<BridgeResponse> {
  const params = normalizeEvaluateParams(request.params);
  if (!params.expression) {
    return createFailure(request.id, ERROR_CODES.INVALID_REQUEST, 'expression is required.', null, {
      method: request.method,
    });
  }
  const target = await dependencies.resolveRequestTarget(request);
  const assertActive = requestLifetimes.guard(request.id);
  // Runtime.evaluate's own timeout stops synchronous execution only; a promise
  // that never settles would hold the tab's debugger lane forever. Bound the
  // whole command, and release it when the request is canceled.
  const laneTimeoutMs = params.timeoutMs + EVALUATE_GRACE_MS;
  let abandoned = false;
  let stopTracking = () => {};
  try {
    return await dependencies.runWithDebugger(
      target.tabId,
      async (debugTarget) => {
        assertActive();
        const command = dependencies.sendCommand(debugTarget, 'Runtime.evaluate', {
          expression: params.expression,
          returnByValue: params.returnByValue,
          awaitPromise: params.awaitPromise,
          timeout: params.timeoutMs,
          userGesture: true,
          generatePreview: false,
        });
        const canceled = new Promise<never>((_resolve, reject) => {
          stopTracking = requestLifetimes.track(request.id, () => {
            abandoned = true;
            reject(
              new BridgeError(
                ERROR_CODES.TIMEOUT,
                'page.evaluate was canceled before the page answered; the debugger session was released.',
                { stage: 'Runtime.evaluate', outcomeUncertain: true }
              )
            );
          });
        });
        command.catch(() => {});
        const result = await Promise.race([command, canceled]);
        return toEvaluateResponse(request, result);
      },
      { timeoutMs: laneTimeoutMs }
    );
  } finally {
    stopTracking();
    if (abandoned) await dependencies.discardDebuggerSession?.(target.tabId).catch(() => {});
  }
}

/** Slack over the expression timeout for CDP round trips and serialization. */
const EVALUATE_GRACE_MS = 2_000;

function toEvaluateResponse(request: BridgeRequest, result: unknown): BridgeResponse {
  const cdpResult = result as {
    result?: { type?: string; value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (cdpResult.exceptionDetails) {
    const errText =
      cdpResult.exceptionDetails.exception?.description ||
      cdpResult.exceptionDetails.text ||
      'Evaluation failed.';
    // A page exception is the expression's outcome, not a bridge fault.
    return createFailure(
      request.id,
      ERROR_CODES.EVALUATION_FAILED,
      errText.slice(0, 2000),
      { exception: errText.slice(0, 2000) },
      { method: request.method }
    );
  }
  return createSuccess(
    request.id,
    {
      value: cdpResult.result?.value ?? null,
      type: cdpResult.result?.type ?? 'undefined',
    },
    { method: request.method }
  );
}
