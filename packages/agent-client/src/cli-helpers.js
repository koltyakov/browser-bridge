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

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid JSON syntax. Expected a JSON object, e.g. \'{"key":"value"}\'.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object but got ${Array.isArray(parsed) ? 'array' : typeof parsed}. Wrap your input in {}.`);
  }

  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Parse a CLI argument as a positive integer, throwing a user-friendly error
 * if the value is missing or not a finite number.
 *
 * @param {string | undefined} value
 * @param {string} argName - The argument name shown in the error message
 * @returns {number}
 */
export function parseIntArg(value, argName) {
  const n = Number(value);
  if (!value || !Number.isFinite(n)) {
    throw new Error(`${argName} must be a number (got ${JSON.stringify(value)}).`);
  }
  return n;
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
