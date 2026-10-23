// @ts-check
import {
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_PERFORM_TIMEOUT_MS,
  MAX_PERFORM_TIMEOUT_MS,
} from './defaults.js';

/** @typedef {{field: string, fallback: number, min: number, max: number}} TimeoutField */
/** @typedef {{base: number, fields: TimeoutField[]}} OperationTimeoutPolicy */
/** @param {string} field @param {number} fallback @param {number} min @param {number} max @returns {TimeoutField} */
const field = (field, fallback, min, max) => ({ field, fallback, min, max });

/** Transport wait policies, also embedded in the native runtime catalog.
 * Input actions retain a conservative floor for auto-wait and observation.
 * @type {Record<string, OperationTimeoutPolicy>}
 */
export const OPERATION_TIMEOUT_POLICIES = {
  'session.read': { base: 5000, fields: [field('waitMs', 0, 0, 25000)] },
  'session.stop': { base: 100000, fields: [] },
  'session.export': { base: 100000, fields: [] },
  'session.release': { base: 100000, fields: [] },
  'download.resource': { base: 5000, fields: [field('timeoutMs', 30000, 100, 60000)] },
  'webmcp.execute_tool': {
    base: 10000,
    fields: [field('approvalTimeoutMs', 60000, 1000, 60000), field('timeoutMs', 10000, 100, 30000)],
  },
  'webmcp.list_tools': { base: 5000, fields: [] },
  'webmcp.get_tool': { base: 5000, fields: [] },
  'navigation.navigate': {
    base: 0,
    fields: [field('timeoutMs', DEFAULT_NAV_TIMEOUT_MS, 500, 120000)],
  },
  'navigation.reload': {
    base: 0,
    fields: [field('timeoutMs', DEFAULT_NAV_TIMEOUT_MS, 500, 120000)],
  },
  'navigation.go_back': {
    base: 0,
    fields: [field('timeoutMs', DEFAULT_NAV_TIMEOUT_MS, 500, 120000)],
  },
  'navigation.go_forward': {
    base: 0,
    fields: [field('timeoutMs', DEFAULT_NAV_TIMEOUT_MS, 500, 120000)],
  },
  'page.wait_for_load_state': {
    base: 0,
    fields: [field('timeoutMs', DEFAULT_NAV_TIMEOUT_MS, 500, 120000)],
  },
  'page.evaluate': { base: 0, fields: [field('timeoutMs', DEFAULT_EVAL_TIMEOUT_MS, 100, 30000)] },
  'dom.wait_for': { base: 0, fields: [field('timeoutMs', DEFAULT_WAIT_TIMEOUT_MS, 100, 30000)] },
  'input.perform': {
    base: 0,
    fields: [field('timeoutMs', DEFAULT_PERFORM_TIMEOUT_MS, 100, MAX_PERFORM_TIMEOUT_MS)],
  },
};

/** @param {string} method @param {Record<string, unknown>} params @returns {number | null} */
export function getOperationTimeout(method, params) {
  const policy = OPERATION_TIMEOUT_POLICIES[method];
  if (!policy) return null;
  return policy.fields.reduce((total, rule) => {
    const raw = params[rule.field];
    const number = raw === null || raw === undefined ? NaN : Number(raw);
    return (
      total +
      (Number.isFinite(number)
        ? Math.max(rule.min, Math.min(rule.max, Math.trunc(number)))
        : rule.fallback)
    );
  }, policy.base);
}
