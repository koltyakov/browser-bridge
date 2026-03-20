// @ts-check

export function parsePropertyAssignments(values) {
  return values.reduce((accumulator, item) => {
    const index = item.indexOf('=');
    if (index <= 0) {
      return accumulator;
    }
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) {
      accumulator[key] = value;
    }
    return accumulator;
  }, /** @type {Record<string, string>} */ ({}));
}

export function parseCommaList(value) {
  if (!value) {
    return [];
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * @param {string | undefined} value
 * @returns {Record<string, unknown>}
 */
export function parseJsonObject(value) {
  if (!value) {
    return {};
  }

  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object input.');
  }

  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * @param {string} method
 * @returns {boolean}
 */
export function methodNeedsSession(method) {
  return ![
    'health.ping',
    'log.tail',
    'tabs.list',
    'tabs.create',
    'tabs.close',
    'session.request_access',
    'skill.get_runtime_context'
  ].includes(method);
}
