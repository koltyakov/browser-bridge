// @ts-check

import { METHODS } from '../../protocol/src/index.js';
import { methodNeedsTab, parseIntArg, parseJsonObject } from './cli-helpers.js';

/** @typedef {import('./types.js').BridgeMethod} BridgeMethod */

/**
 * Read all of stdin as UTF-8 text. Resolves once stdin closes.
 *
 * @returns {Promise<string>}
 */
export function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = /** @type {Buffer[]} */ ([]);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
    process.stdin.on('error', reject);
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

/**
 * Extract the global --remote flag from anywhere in the argument list.
 * Exits with a usage error when the flag is present without a value.
 *
 * @param {string[]} args
 * @returns {{ remoteId: string | null, explicit: boolean, rest: string[] }}
 */
export function extractRemoteFlag(args) {
  const rest = [...args];
  const index = rest.indexOf('--remote');
  if (index === -1) {
    return { remoteId: null, explicit: false, rest };
  }
  const remoteId = rest[index + 1];
  if (!remoteId || remoteId.startsWith('--')) {
    process.stderr.write('--remote requires a destination name (see `bbx remote list`).\n');
    process.exit(1);
  }
  rest.splice(index, 2);
  return { remoteId, explicit: true, rest };
}

/**
 * @param {string[]} args
 * @returns {{ tabId: number | null, rest: string[] }}
 */
export function extractTabFlag(args) {
  const rest = [...args];
  let tabId = null;
  const tabIndex = rest.indexOf('--tab');
  if (tabIndex !== -1) {
    tabId = parseIntArg(rest[tabIndex + 1], 'tabId');
    rest.splice(tabIndex, 2);
  }
  return { tabId, rest };
}

/**
 * @param {string[]} args
 * @returns {{ format: 'png' | 'jpeg' | 'webp', quality: number | undefined, rest: string[] }}
 */
export function extractScreenshotFlags(args) {
  const rest = [...args];
  const formatIndex = rest.indexOf('--format');
  const rawFormat = formatIndex === -1 ? 'png' : rest[formatIndex + 1];
  if (rawFormat !== 'png' && rawFormat !== 'jpeg' && rawFormat !== 'webp') {
    throw new Error('--format must be png, jpeg, or webp.');
  }
  if (formatIndex !== -1) rest.splice(formatIndex, 2);
  const qualityIndex = rest.indexOf('--quality');
  let quality;
  if (qualityIndex !== -1) {
    quality = Number(rest[qualityIndex + 1]);
    if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
      throw new Error('--quality must be an integer from 0 to 100.');
    }
    rest.splice(qualityIndex, 2);
  }
  return { format: rawFormat, quality, rest };
}

/**
 * @param {string[]} args
 * @returns {{ limit: number | undefined, urlPattern: string | undefined, delivery: 'inline' | 'artifact' | 'auto', rest: string[] }}
 */
export function extractHarFlags(args) {
  const rest = [...args];
  const limitIndex = rest.indexOf('--limit');
  let limit;
  if (limitIndex !== -1) {
    limit = Number(rest[limitIndex + 1]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('--limit must be an integer from 1 to 200.');
    }
    rest.splice(limitIndex, 2);
  }

  const urlPatternIndex = rest.indexOf('--url-pattern');
  const urlPattern = urlPatternIndex === -1 ? undefined : rest[urlPatternIndex + 1];
  if (urlPatternIndex !== -1) {
    if (!urlPattern || urlPattern.startsWith('--')) {
      throw new Error('--url-pattern requires a value.');
    }
    rest.splice(urlPatternIndex, 2);
  }

  const deliveryIndex = rest.indexOf('--delivery');
  const rawDelivery = deliveryIndex === -1 ? 'auto' : rest[deliveryIndex + 1];
  if (rawDelivery !== 'inline' && rawDelivery !== 'artifact' && rawDelivery !== 'auto') {
    throw new Error('--delivery must be inline, artifact, or auto.');
  }
  if (deliveryIndex !== -1) rest.splice(deliveryIndex, 2);

  return { limit, urlPattern, delivery: rawDelivery, rest };
}

/**
 * @param {string[]} args
 * @returns {Promise<{ tabId: number | null, method: BridgeMethod, params: Record<string, unknown> }>}
 */
export async function parseCallCommand(args) {
  const parsed = extractTabFlag(args);
  const [first, second, ...extra] = parsed.rest;
  if (!first) {
    throw new Error('Usage: call [--tab <tabId>] <method> [paramsJson]');
  }
  if (extra.length > 0) {
    throw new Error('Usage: call [--tab <tabId>] <method> [paramsJson]');
  }

  if (first.includes('.')) {
    const method = /** @type {BridgeMethod} */ (first);
    if (!METHODS.includes(method)) {
      throw new Error(`Unknown method "${first}". Run bbx skill to see available methods.`);
    }
    let rawParams = second;
    // Support piped stdin: `echo '{"key":"val"}' | bbx call method -`
    if (rawParams === '-') {
      rawParams = await readStdin();
    }
    return {
      method,
      tabId: methodNeedsTab(method) ? parsed.tabId : null,
      params: parseJsonObject(rawParams),
    };
  }

  throw new Error('Usage: call [--tab <tabId>] <method> [paramsJson]');
}

/**
 * @param {string[]} args
 * @returns {{ pattern: string, isBlock: boolean, statusCode: number, body: string | undefined }}
 */
export function parseInterceptAddArgs(args) {
  const [pattern, ...optionArgs] = args;
  if (!pattern || pattern.startsWith('--')) {
    throw new Error(
      'Usage: intercept add <urlPattern> [--respond <body>] [--status <code>] [--block]'
    );
  }

  let isBlock = false;
  let statusCode = 200;
  let hasStatus = false;
  let body;
  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];
    if (option === '--block') {
      if (isBlock) {
        throw new Error('The --block option may only be specified once.');
      }
      isBlock = true;
      continue;
    }
    if (option === '--respond') {
      const value = optionArgs[++index];
      if (body !== undefined) {
        throw new Error('The --respond option may only be specified once.');
      }
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--respond requires a body value.');
      }
      body = value;
      continue;
    }
    if (option === '--status') {
      if (hasStatus) {
        throw new Error('The --status option may only be specified once.');
      }
      const value = optionArgs[++index];
      statusCode = parseIntArg(value, 'status');
      if (statusCode < 100 || statusCode > 599) {
        throw new Error('status must be an integer between 100 and 599.');
      }
      hasStatus = true;
      continue;
    }
    throw new Error(`Unknown or extra intercept add option "${option}".`);
  }

  if (isBlock && body !== undefined) {
    throw new Error('Use either --block or --respond, not both.');
  }
  return { pattern, isBlock, statusCode, body };
}
