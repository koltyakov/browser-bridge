// @ts-check

import { sanitizeIncidentalValue } from '../../protocol/src/index.js';

/** @typedef {{ write: (chunk: string) => void }} LogStream */

/**
 * @enum {number}
 * @private
 */
const LOG_LEVELS = /** @type {const} */ ({
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
});

/** @typedef {keyof typeof LOG_LEVELS} LogLevel */

/**
 * @typedef {{
 *   debug(message: string, extra?: Record<string, unknown>): void;
 *   info(message: string, extra?: Record<string, unknown>): void;
 *   warn(message: string, extra?: Record<string, unknown>): void;
 *   error(message: string, extra?: Record<string, unknown>): void;
 * }} DaemonLoggerLike
 */

/**
 * Structured JSON logger for the daemon. Each call emits a single NDJSON line
 * with a timestamp, level, message, and optional structured fields.
 */
export class DaemonLogger {
  /** @type {LogStream} */
  #stream;
  /** @type {LogLevel} */
  #minLevel;
  /** @type {Record<string, unknown>} */
  #defaults;

  /**
   * @param {{ stream?: LogStream, minLevel?: LogLevel, defaults?: Record<string, unknown> }} [options]
   */
  constructor({ stream, minLevel = 'info', defaults = {} } = {}) {
    this.#stream = stream ?? /** @type {LogStream} */ (process.stderr);
    this.#minLevel = minLevel;
    this.#defaults = defaults;
  }

  /**
   * @param {LogLevel} level
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   * @returns {void}
   */
  #write(level, message, extra) {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.#minLevel]) {
      return;
    }
    const entry = {
      ...this.#defaults,
      timestamp: new Date().toISOString(),
      level,
      message,
      ...extra,
    };
    this.#stream.write(`${JSON.stringify(sanitizeIncidentalValue(entry))}\n`);
  }

  /**
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   * @returns {void}
   */
  debug(message, extra) {
    this.#write('debug', message, extra);
  }

  /**
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   * @returns {void}
   */
  info(message, extra) {
    this.#write('info', message, extra);
  }

  /**
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   * @returns {void}
   */
  warn(message, extra) {
    this.#write('warn', message, extra);
  }

  /**
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   * @returns {void}
   */
  error(message, extra) {
    this.#write('error', message, extra);
  }
}

/**
 * A silent logger that discards all output. Useful in tests.
 * @type {DaemonLoggerLike}
 */
export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Wrap a legacy `Pick<Console, 'log' | 'error'>` logger into the new
 * `DaemonLoggerLike` interface. Used for backward compatibility with
 * callers that still pass `{ log() {}, error() {} }`.
 *
 * @param {Pick<Console, 'log' | 'error'>} legacy
 * @returns {DaemonLoggerLike}
 */
export function wrapLegacyLogger(legacy) {
  return {
    debug(message, extra) {
      legacy.log?.(`[debug] ${message}`, extra ?? '');
    },
    info(message, extra) {
      legacy.log?.(`[info] ${message}`, extra ?? '');
    },
    warn(message, extra) {
      legacy.log?.(`[warn] ${message}`, extra ?? '');
    },
    error(message, extra) {
      legacy.error?.(`[error] ${message}`, extra ?? '');
    },
  };
}

/**
 * Accept either a `DaemonLoggerLike` or a legacy `Pick<Console, 'log' | 'error'>`
 * and return a normalized `DaemonLoggerLike`. If the input already has an `info`
 * method it is returned as-is; otherwise it is wrapped via `wrapLegacyLogger`.
 *
 * @param {DaemonLoggerLike | Pick<Console, 'log' | 'error'> | undefined} logger
 * @returns {DaemonLoggerLike}
 */
export function normalizeDaemonLogger(logger) {
  if (logger === undefined) {
    return new DaemonLogger();
  }
  if (typeof (/** @type {any} */ (logger).info) === 'function') {
    return /** @type {DaemonLoggerLike} */ (logger);
  }
  return wrapLegacyLogger(/** @type {Pick<Console, 'log' | 'error'>} */ (logger));
}
