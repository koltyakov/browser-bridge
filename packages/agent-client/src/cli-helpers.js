// @ts-check

import readline from 'node:readline';

/**
 * @param {string[]} values
 * @returns {Record<string, string>}
 */
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

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
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

/**
 * Present an interactive checkbox list on the terminal.
 * Returns an array of selected values, or null when stdin is not a TTY
 * (caller should fall back to a sensible default).
 *
 * Controls: ↑↓ move · space toggle · a toggle all · enter confirm · ctrl+c cancel
 *
 * @param {string} title
 * @param {Array<{value: string, label: string, hint?: string, checked?: boolean}>} items
 * @returns {Promise<string[] | null>}
 */
export async function interactiveCheckbox(title, items) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || items.length === 0) {
    return null;
  }

  readline.emitKeypressEvents(process.stdin);

  let cursorRow = 0;
  /** @type {Set<string>} */
  const checked = new Set(items.filter((i) => i.checked).map((i) => i.value));
  let firstRender = true;

  /**
   * @param {boolean} [final]
   */
  function render(final = false) {
    let out = '';
    if (!firstRender) {
      // Move cursor back to the title line and overwrite
      out += `\x1b[${items.length + 1}A`;
    }
    firstRender = false;

    out += `\r\x1b[2K${title}\n`;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isActive = !final && i === cursorRow;
      const isChecked = checked.has(item.value);
      const prefix = isActive ? '\x1b[36m›\x1b[0m' : ' ';
      const box = isChecked ? '\x1b[32m[x]\x1b[0m' : '[ ]';
      const label = isActive ? `\x1b[1m${item.label}\x1b[0m` : item.label;
      const hint = item.hint ? `  \x1b[90m${item.hint}\x1b[0m` : '';
      out += `\r\x1b[2K${prefix} ${box} ${label}${hint}\n`;
    }
    process.stdout.write(out);
  }

  process.stdout.write('\x1b[?25l'); // hide cursor
  if (typeof /** @type {any} */ (process.stdin).setRawMode === 'function') {
    /** @type {any} */ (process.stdin).setRawMode(true);
  }
  process.stdin.resume();
  render();

  return new Promise((resolve) => {
    /**
     * @param {string[] | null} result
     */
    function cleanup(result) {
      process.stdin.removeListener('keypress', onKeypress);
      if (typeof /** @type {any} */ (process.stdin).setRawMode === 'function') {
        /** @type {any} */ (process.stdin).setRawMode(false);
      }
      process.stdin.pause();
      render(true); // final render without active highlight
      process.stdout.write('\x1b[?25h'); // show cursor
      resolve(result);
    }

    /**
     * @param {unknown} _ch
     * @param {{ name?: string, ctrl?: boolean } | undefined} key
     */
    function onKeypress(_ch, key) {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup(null);
        process.exit(130);
      }
      if (key.name === 'up') {
        cursorRow = Math.max(0, cursorRow - 1);
      } else if (key.name === 'down') {
        cursorRow = Math.min(items.length - 1, cursorRow + 1);
      } else if (key.name === 'space') {
        const val = items[cursorRow].value;
        if (checked.has(val)) checked.delete(val);
        else checked.add(val);
      } else if (key.name === 'a') {
        if (checked.size === items.length) {
          checked.clear();
        } else {
          for (const item of items) checked.add(item.value);
        }
      } else if (key.name === 'return') {
        cleanup([...checked]);
        return;
      }
      render();
    }

    process.stdin.on('keypress', onKeypress);
  });
}
