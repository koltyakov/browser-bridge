// @ts-check

import {
  BridgeError,
  ERROR_CODES,
  MAX_INTERCEPT_RULES_PER_TAB,
  normalizeNetworkInterceptAddParams,
} from '../../protocol/src/index.js';

/**
 * CDP Fetch-domain request interception - declarative rule engine.
 *
 * Agents add rules (URL pattern → action) upfront. When a matching request
 * fires, the extension auto-handles it via Fetch.fulfillRequest or
 * Fetch.continueRequest. No agent round-trip per request.
 *
 * Debugger session lifecycle:
 *   - First rule added → acquire debugger via TabDebuggerCoordinator
 *   - Last rule removed / clear → release debugger
 *   - 10-minute TTL auto-expires the session (safety net)
 *
 * Fetch.enable patterns are scoped to the active rule set (re-sent on every
 * add/remove), so only requests that could match a rule ever pause at the
 * debugger.
 *
 * State is per-tab and in-memory only: if the MV3 service worker is suspended
 * or the debugger detaches (user cancels the infobar, tab closes), rules are
 * gone and interception stops. Callers should treat rules as best-effort and
 * verify with network.intercept.list. handleDetach() reconciles local state
 * when the background script observes a detach event.
 */

/** @typedef {{ ruleId: string, urlPattern: string, action: 'fulfill' | 'continue' | 'block', statusCode?: number, body?: string, headers?: Record<string, string> }} InterceptRule */
/** @typedef {InterceptRule & { matcher: RegExp }} StoredInterceptRule */
/** @typedef {{ rules: Map<string, StoredInterceptRule>, ownsDebugger: boolean, ttlTimer?: ReturnType<typeof setTimeout> }} TabInterceptState */

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const TEARDOWN_RETRY_MS = 5_000;
const MAX_DIAGNOSTIC_COUNT = 10_000;
const MAX_PENDING_PER_TAB = 64;
const MAX_PENDING_GLOBAL = 256;
const MAX_TRACKED_TABS = 64;

/** @typedef {Omit<InterceptRule, 'ruleId'>} InterceptRuleInput */

/**
 * Validate untrusted bridge parameters before they become an active rule.
 *
 * @param {Record<string, unknown>} input
 * @returns {InterceptRuleInput}
 */
export function validateInterceptRule(input) {
  return normalizeNetworkInterceptAddParams(input);
}

/**
 * @param {{
 *   acquireDebugger: (tabId: number, init?: (target: {tabId: number}) => Promise<void>) => Promise<void>,
 *   releaseDebugger: (tabId: number) => Promise<void>,
 *   assertDebuggerAvailable?: (tabId: number) => void,
 *   sendCommand: (target: {tabId: number}, method: string, params: object) => Promise<unknown>,
 *   addEventFilter: (tabId: number, handler: (method: string, params: unknown) => void) => void,
 *   removeEventFilter: (tabId: number) => void,
 * }} deps
 */
export function createFetchInterceptor(deps) {
  /** @type {Map<number, TabInterceptState>} */
  const tabStates = new Map();
  /** @type {Map<number, Promise<void>>} */
  const lifecycleQueues = new Map();
  /** @type {Map<number, { pending: number, additions: number, cleanup: boolean }>} */
  const admissions = new Map();
  let pendingGlobal = 0;

  let ruleCounter = 0;

  /**
   * @template T
   * @param {number} tabId
   * @param {(publishAddition: () => void) => Promise<T>} task
   * @param {'mutation' | 'add' | 'cleanup'} [kind]
   * @returns {Promise<T>}
   */
  async function runLifecycle(tabId, task, kind = 'mutation') {
    const admission = admissions.get(tabId) ?? { pending: 0, additions: 0, cleanup: false };
    const cleanup = kind === 'cleanup';
    // Reserve one cleanup slot per retained tab, outside ordinary work limits.
    // Reject duplicates instead of retaining unbounded waiters on a shared promise.
    if (
      admission.cleanup ||
      (!cleanup &&
        (admission.pending >= MAX_PENDING_PER_TAB || pendingGlobal >= MAX_PENDING_GLOBAL)) ||
      (!admissions.has(tabId) &&
        !tabStates.has(tabId) &&
        new Set([...admissions.keys(), ...tabStates.keys()]).size >= MAX_TRACKED_TABS)
    ) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'Interception lifecycle capacity exceeded or cleanup already pending. Retry after pending work completes.'
      );
    }
    if (
      kind === 'add' &&
      (tabStates.get(tabId)?.rules.size ?? 0) + admission.additions >= MAX_INTERCEPT_RULES_PER_TAB
    ) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        `A tab may have at most ${MAX_INTERCEPT_RULES_PER_TAB} active or pending interception rules.`
      );
    }
    admissions.set(tabId, admission);
    admission.pending += 1;
    if (cleanup) admission.cleanup = true;
    else pendingGlobal += 1;
    let reserved = kind === 'add';
    if (reserved) admission.additions += 1;
    const publishAddition = () => {
      if (!reserved) return;
      reserved = false;
      admission.additions -= 1;
    };
    const previous = lifecycleQueues.get(tabId) ?? Promise.resolve();
    const operation = previous.then(() => task(publishAddition));
    const tail = operation.then(
      () => {},
      () => {}
    );
    lifecycleQueues.set(tabId, tail);
    try {
      return await operation;
    } finally {
      publishAddition();
      admission.pending -= 1;
      if (cleanup) admission.cleanup = false;
      else pendingGlobal -= 1;
      if (admission.pending === 0) admissions.delete(tabId);
      if (lifecycleQueues.get(tabId) === tail) lifecycleQueues.delete(tabId);
    }
  }

  /**
   * @param {number} tabId
   * @returns {TabInterceptState}
   */
  function getOrCreateState(tabId) {
    let s = tabStates.get(tabId);
    if (!s) {
      s = { rules: new Map(), ownsDebugger: false };
      tabStates.set(tabId, s);
    }
    return s;
  }

  /** @param {number} tabId @param {number} [delayMs] */
  function resetTtl(tabId, delayMs = TTL_MS) {
    const s = tabStates.get(tabId);
    if (!s) return;
    if (s.ttlTimer) clearTimeout(s.ttlTimer);
    const timer = setTimeout(() => {
      void runLifecycle(
        tabId,
        async () => {
          if (tabStates.get(tabId) !== s || s.ttlTimer !== timer) return;
          s.rules.clear();
          await releaseTab(tabId, s);
        },
        'cleanup'
      ).catch(() => {});
    }, delayMs);
    s.ttlTimer = timer;
    if (
      typeof s.ttlTimer === 'object' &&
      s.ttlTimer &&
      'unref' in s.ttlTimer &&
      typeof s.ttlTimer.unref === 'function'
    ) {
      s.ttlTimer.unref();
    }
  }

  /**
   * Re-send Fetch.enable with patterns derived from the current rule set.
   * Fetch.enable replaces previously registered patterns, so this both
   * narrows and widens interception as rules change.
   * @param {number} tabId
   */
  async function syncPatterns(tabId) {
    const s = tabStates.get(tabId);
    if (!s || s.rules.size === 0) return;
    const patterns = [...new Set([...s.rules.values()].map((rule) => rule.urlPattern))].map(
      (urlPattern) => ({ urlPattern, requestStage: 'Request' })
    );
    await deps.sendCommand({ tabId }, 'Fetch.enable', { patterns });
  }

  /**
   * @param {number} tabId
   * @param {Record<string, unknown>} rule
   * @returns {Promise<InterceptRule>}
   */
  async function addRule(tabId, rule) {
    const validatedRule = validateInterceptRule(rule);
    deps.assertDebuggerAvailable?.(tabId);
    return runLifecycle(
      tabId,
      async (publishAddition) => {
        deps.assertDebuggerAvailable?.(tabId);
        const stopping = tabStates.get(tabId);
        if (stopping && stopping.rules.size === 0) await releaseTab(tabId, stopping);
        const s = getOrCreateState(tabId);
        if (s.rules.size >= MAX_INTERCEPT_RULES_PER_TAB) {
          throw new BridgeError(
            ERROR_CODES.INVALID_REQUEST,
            `A tab may have at most ${MAX_INTERCEPT_RULES_PER_TAB} active interception rules.`
          );
        }
        const ruleId = `intercept_${++ruleCounter}`;
        const fullRule = {
          ...validatedRule,
          ruleId,
          matcher: compileUrlPattern(validatedRule.urlPattern),
        };
        const wasEmpty = s.rules.size === 0;
        publishAddition();
        s.rules.set(ruleId, fullRule);

        try {
          if (wasEmpty) {
            deps.addEventFilter(tabId, (method, params) => handleFetchEvent(tabId, method, params));
            await deps.acquireDebugger(tabId, async () => {});
            if (tabStates.get(tabId) !== s)
              throw new Error('Debugger detached while adding interception rule.');
            s.ownsDebugger = true;
          }
          await syncPatterns(tabId);
          if (tabStates.get(tabId) !== s)
            throw new Error('Debugger detached while adding interception rule.');
        } catch (error) {
          // Roll back so a failed acquire/enable does not leave a phantom rule.
          s.rules.delete(ruleId);
          if (s.rules.size === 0) await releaseTab(tabId, s).catch(() => {});
          throw error;
        }

        resetTtl(tabId);
        return toPublicRule(fullRule);
      },
      'add'
    );
  }

  /**
   * @param {number} tabId
   * @param {string} ruleId
   * @returns {Promise<boolean>}
   */
  async function removeRule(tabId, ruleId) {
    return runLifecycle(tabId, async () => {
      const s = tabStates.get(tabId);
      if (!s) return false;
      const removed = s.rules.delete(ruleId);
      if (removed && s.rules.size === 0) {
        await releaseTab(tabId, s);
      } else if (removed) {
        await syncPatterns(tabId);
      }
      return removed;
    });
  }

  /**
   * @param {number} tabId
   * @returns {InterceptRule[]}
   */
  function listRules(tabId) {
    const s = tabStates.get(tabId);
    return s ? [...s.rules.values()].map(toPublicRule) : [];
  }

  /**
   * @param {number} tabId
   * @returns {Promise<number>}
   */
  async function clearAllRules(tabId) {
    if (!tabStates.has(tabId) && !admissions.has(tabId)) return 0;
    return runLifecycle(
      tabId,
      async () => {
        const s = tabStates.get(tabId);
        if (!s) return 0;
        const count = s.rules.size;
        s.rules.clear();
        await releaseTab(tabId, s);
        return count;
      },
      'cleanup'
    );
  }

  /**
   * Reconcile local state after the debugger detached out from under us
   * (user dismissed the infobar, tab closed, or another tool took over).
   * Drops rules and filters without trying to release an already-dead
   * session, so network.intercept.list reflects reality.
   * @param {number} tabId
   */
  function handleDetach(tabId) {
    const s = tabStates.get(tabId);
    if (!s) return;
    if (s.ttlTimer) clearTimeout(s.ttlTimer);
    tabStates.delete(tabId);
    deps.removeEventFilter(tabId);
  }

  /**
   * @returns {{ status: 'idle' | 'active', activeTabCount: number, ruleCount: number }}
   */
  function getDiagnostics() {
    let activeTabCount = 0;
    let ruleCount = 0;
    for (const state of tabStates.values()) {
      if (state.rules.size > 0 || state.ownsDebugger) activeTabCount += 1;
      ruleCount += state.rules.size;
    }
    return {
      status: activeTabCount > 0 ? 'active' : 'idle',
      activeTabCount: Math.min(activeTabCount, MAX_DIAGNOSTIC_COUNT),
      ruleCount: Math.min(ruleCount, MAX_DIAGNOSTIC_COUNT),
    };
  }

  /**
   * @param {number} tabId
   * @param {TabInterceptState} expectedState
   */
  async function releaseTab(tabId, expectedState) {
    const s = tabStates.get(tabId);
    if (s !== expectedState) return;
    if (s.ttlTimer) clearTimeout(s.ttlTimer);
    s.rules.clear();
    if (s.ownsDebugger) {
      try {
        await deps.sendCommand({ tabId }, 'Fetch.disable', {});
      } catch (error) {
        if (tabStates.get(tabId) !== s) return;
        const message = error instanceof Error ? error.message : String(error);
        if (/not attached|no target with given id/i.test(message)) {
          handleDetach(tabId);
          return;
        }
        // Another domain may hold the debugger. Keep handling paused requests
        // without applying rules until Fetch is confirmed disabled.
        resetTtl(tabId, TEARDOWN_RETRY_MS);
        throw error;
      }
      if (tabStates.get(tabId) !== s) return;
      await deps.releaseDebugger(tabId).catch(() => {});
    }
    if (tabStates.get(tabId) !== s) return;
    tabStates.delete(tabId);
    deps.removeEventFilter(tabId);
  }

  /**
   * Handle CDP Fetch.requestPaused events - match against rules, auto-respond.
   * @param {number} tabId
   * @param {string} method
   * @param {unknown} params
   */
  async function handleFetchEvent(tabId, method, params) {
    if (method !== 'Fetch.requestPaused') return;

    const requestId = getPausedRequestId(params);
    try {
      const p = getPausedRequest(params);
      const s = tabStates.get(tabId);
      if (!s || s.rules.size === 0) {
        await deps.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId: p.requestId });
        return;
      }

      let matchedRule = null;
      for (const rule of s.rules.values()) {
        if (rule.matcher.test(p.request.url)) {
          matchedRule = rule;
          break;
        }
      }

      if (!matchedRule || matchedRule.action === 'continue') {
        /** @type {Record<string, unknown>} */
        const continueParams = { requestId: p.requestId };
        if (matchedRule?.headers) {
          continueParams.headers = mergeRequestHeaders(p.request.headers, matchedRule.headers);
        }
        await deps.sendCommand({ tabId }, 'Fetch.continueRequest', continueParams);
      } else if (matchedRule.action === 'block') {
        await deps.sendCommand({ tabId }, 'Fetch.failRequest', {
          requestId: p.requestId,
          errorReason: 'BlockedByClient',
        });
      } else if (matchedRule.action === 'fulfill') {
        const body = matchedRule.body ?? '';
        await deps.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: matchedRule.statusCode ?? 200,
          responseHeaders: Object.entries(
            matchedRule.headers ?? { 'content-type': 'application/json' }
          ).map(([name, value]) => ({ name, value })),
          body: btoa(unescape(encodeURIComponent(body))),
        });
      }
    } catch {
      if (!requestId) return;
      try {
        await deps.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId });
      } catch {
        // The debugger may have detached while the request was paused.
      }
    }
  }

  return {
    addRule,
    removeRule,
    listRules,
    clearAllRules,
    releaseTab,
    handleDetach,
    getDiagnostics,
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {unknown} params
 * @returns {string | null}
 */
function getPausedRequestId(params) {
  if (!isPlainRecord(params) || typeof params.requestId !== 'string' || !params.requestId) {
    return null;
  }
  return params.requestId;
}

/**
 * @param {unknown} params
 * @returns {{ requestId: string, request: { url: string, headers: Record<string, string> | Array<{ name: string, value: string }> } }}
 */
function getPausedRequest(params) {
  const requestId = getPausedRequestId(params);
  if (!requestId || !isPlainRecord(params) || !isPlainRecord(params.request)) {
    throw new Error('Malformed Fetch.requestPaused event.');
  }
  const request = params.request;
  if (typeof request.url !== 'string') {
    throw new Error('Malformed Fetch.requestPaused request URL.');
  }
  const headers = request.headers;
  if (!isPlainRecord(headers) && !Array.isArray(headers)) {
    throw new Error('Malformed Fetch.requestPaused request headers.');
  }
  return {
    requestId,
    request: {
      url: request.url,
      headers: /** @type {Record<string, string> | Array<{ name: string, value: string }>} */ (
        headers
      ),
    },
  };
}

/**
 * @param {Record<string, string> | Array<{ name: string, value: string }>} original
 * @param {Record<string, string>} overrides
 * @returns {Array<{ name: string, value: string }>}
 */
function mergeRequestHeaders(original, overrides) {
  const originalEntries = Array.isArray(original)
    ? original
    : Object.entries(original).map(([name, value]) => ({ name, value }));
  /** @type {Array<{ name: string, value: string }>} */
  const merged = [];
  const indexes = new Map();

  for (const header of originalEntries) {
    if (typeof header?.name !== 'string' || typeof header.value !== 'string') continue;
    const key = header.name.toLowerCase();
    if (indexes.has(key)) continue;
    indexes.set(key, merged.length);
    merged.push({ name: header.name, value: header.value });
  }
  for (const [name, value] of Object.entries(overrides)) {
    const key = name.toLowerCase();
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, merged.length);
      merged.push({ name, value });
    } else {
      merged[index] = { name: merged[index].name, value };
    }
  }
  return merged;
}

/**
 * Glob-style URL pattern matching mirroring CDP Fetch.enable semantics:
 * `*` matches any characters, `?` matches exactly one character.
 * `?` must not stay a regex quantifier, or query-string patterns like
 * `/v1?x=1*` silently stop matching.
 * @param {string} pattern
 * @returns {RegExp}
 */
function compileUrlPattern(pattern) {
  return new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i'
  );
}

/** @param {StoredInterceptRule} rule @returns {InterceptRule} */
function toPublicRule(rule) {
  const { matcher: _matcher, ...publicRule } = rule;
  return publicRule;
}
