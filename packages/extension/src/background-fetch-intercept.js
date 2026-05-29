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
 * State is per-tab. Each tab has its own rule set and debugger hold.
 */

/** @typedef {{ ruleId: string, urlPattern: string, action: 'fulfill' | 'continue' | 'block', statusCode?: number, body?: string, headers?: Record<string, string> }} InterceptRule */
/** @typedef {{ rules: Map<string, InterceptRule>, acquirePromise?: Promise<void>, ttlTimer?: ReturnType<typeof setTimeout> }} TabInterceptState */

const TTL_MS = 10 * 60 * 1000; // 10 minutes

/** @typedef {Omit<InterceptRule, 'ruleId'>} InterceptRuleInput */
/** @type {Map<number, TabInterceptState>} */
const tabStates = new Map();

let ruleCounter = 0;

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

    if (wasEmpty) {
      // First rule: acquire debugger + enable Fetch
      deps.addEventFilter(tabId, (method, params) => handleFetchEvent(tabId, method, params));
      await deps.acquireDebugger(tabId, async (target) => {
        await deps.sendCommand(target, 'Fetch.enable', {
          patterns: [{ urlPattern: '*', requestStage: 'Request' }],
        });
      });
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

  return { addRule, removeRule, listRules, clearAllRules, releaseTab };
}

/**
 * Simple glob-style URL pattern matching (* = any chars).
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
function urlMatchesPattern(url, pattern) {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    'i'
  );
  return regex.test(url);
}
