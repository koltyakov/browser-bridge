// @ts-check

/**
 * CDP Fetch-domain request interception — declarative rule engine.
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
/** @typedef {{ rules: Map<string, InterceptRule>, acquirePromise?: Promise<void>, ttlTimer?: ReturnType<typeof setTimeout> }} TabInterceptState */

const TTL_MS = 10 * 60 * 1000; // 10 minutes

/** @typedef {Omit<InterceptRule, 'ruleId'>} InterceptRuleInput */

/**
 * @param {{
 *   acquireDebugger: (tabId: number, init?: (target: {tabId: number}) => Promise<void>) => Promise<void>,
 *   releaseDebugger: (tabId: number) => Promise<void>,
 *   sendCommand: (target: {tabId: number}, method: string, params: object) => Promise<unknown>,
 *   addEventFilter: (tabId: number, handler: (method: string, params: unknown) => void) => void,
 *   removeEventFilter: (tabId: number) => void,
 * }} deps
 */
export function createFetchInterceptor(deps) {
  /** @type {Map<number, TabInterceptState>} */
  const tabStates = new Map();

  let ruleCounter = 0;

  /**
   * @param {number} tabId
   * @returns {TabInterceptState}
   */
  function getOrCreateState(tabId) {
    let s = tabStates.get(tabId);
    if (!s) {
      s = { rules: new Map() };
      tabStates.set(tabId, s);
    }
    return s;
  }

  /** @param {number} tabId */
  function resetTtl(tabId) {
    const s = tabStates.get(tabId);
    if (!s) return;
    if (s.ttlTimer) clearTimeout(s.ttlTimer);
    s.ttlTimer = setTimeout(() => clearAllRules(tabId), TTL_MS);
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
   * @param {InterceptRuleInput} rule
   * @returns {Promise<InterceptRule>}
   */
  async function addRule(tabId, rule) {
    const s = getOrCreateState(tabId);
    const ruleId = `intercept_${++ruleCounter}`;
    const fullRule = { ...rule, ruleId };
    const wasEmpty = s.rules.size === 0;
    s.rules.set(ruleId, fullRule);

    try {
      if (wasEmpty) {
        deps.addEventFilter(tabId, (method, params) => handleFetchEvent(tabId, method, params));
        await deps.acquireDebugger(tabId, async () => {});
      }
      await syncPatterns(tabId);
    } catch (error) {
      // Roll back so a failed acquire/enable does not leave a phantom rule.
      s.rules.delete(ruleId);
      if (s.rules.size === 0) await releaseTab(tabId);
      throw error;
    }

    resetTtl(tabId);
    return fullRule;
  }

  /**
   * @param {number} tabId
   * @param {string} ruleId
   * @returns {Promise<boolean>}
   */
  async function removeRule(tabId, ruleId) {
    const s = tabStates.get(tabId);
    if (!s) return false;
    const removed = s.rules.delete(ruleId);
    if (removed && s.rules.size === 0) {
      await releaseTab(tabId);
    } else if (removed) {
      await syncPatterns(tabId);
    }
    return removed;
  }

  /**
   * @param {number} tabId
   * @returns {InterceptRule[]}
   */
  function listRules(tabId) {
    const s = tabStates.get(tabId);
    return s ? [...s.rules.values()] : [];
  }

  /**
   * @param {number} tabId
   * @returns {Promise<number>}
   */
  async function clearAllRules(tabId) {
    const s = tabStates.get(tabId);
    if (!s) return 0;
    const count = s.rules.size;
    s.rules.clear();
    await releaseTab(tabId);
    return count;
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
   * @param {number} tabId
   */
  async function releaseTab(tabId) {
    const s = tabStates.get(tabId);
    if (s?.ttlTimer) clearTimeout(s.ttlTimer);
    tabStates.delete(tabId);
    try {
      deps.removeEventFilter(tabId);
      await deps.releaseDebugger(tabId);
    } catch {
      // debugger may already be detached
    }
  }

  /**
   * Handle CDP Fetch.requestPaused events — match against rules, auto-respond.
   * @param {number} tabId
   * @param {string} method
   * @param {unknown} params
   */
  async function handleFetchEvent(tabId, method, params) {
    if (method !== 'Fetch.requestPaused') return;

    const p =
      /** @type {{ requestId: string, request: { url: string, method: string, headers: Array<{name: string, value: string}>, postData?: string } }} */ (
        params
      );
    const s = tabStates.get(tabId);
    if (!s || s.rules.size === 0) {
      // No rules, continue the request
      try {
        await deps.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId: p.requestId });
      } catch {
        /* debugger detached */
      }
      return;
    }

    // Find first matching rule
    const url = p.request.url;
    let matchedRule = null;
    for (const rule of s.rules.values()) {
      if (urlMatchesPattern(url, rule.urlPattern)) {
        matchedRule = rule;
        break;
      }
    }

    try {
      if (!matchedRule || matchedRule.action === 'continue') {
        // Continue with optional header modifications
        /** @type {Record<string, unknown>} */
        const continueParams = { requestId: p.requestId };
        if (matchedRule?.headers) {
          continueParams.headers = Object.entries(matchedRule.headers).map(([name, value]) => ({
            name,
            value,
          }));
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
      // Best-effort: if the debugger detached mid-flight, silently drop
    }
  }

  return { addRule, removeRule, listRules, clearAllRules, releaseTab, handleDetach };
}

/**
 * Glob-style URL pattern matching mirroring CDP Fetch.enable semantics:
 * `*` matches any characters, `?` matches exactly one character.
 * `?` must not stay a regex quantifier, or query-string patterns like
 * `/v1?x=1*` silently stop matching.
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
function urlMatchesPattern(url, pattern) {
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i'
  );
  return regex.test(url);
}
