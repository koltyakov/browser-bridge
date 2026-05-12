// @ts-check

import { MAX_JSON_LINE_BYTES } from './defaults.js';

/**
 * Install a newline-delimited JSON parser on a socket's `data` event.
 *
 * @param {import('node:net').Socket} socket
 * @param {(message: unknown) => void} onMessage
 * @param {{ maxLineBytes?: number, onProtocolError?: (error: Error) => void }} [options]
 * @returns {void}
 */
export function parseJsonLines(socket, onMessage, options = {}) {
  let buffer = '';
  const maxLineBytes =
    typeof options.maxLineBytes === 'number' && Number.isFinite(options.maxLineBytes)
      ? Math.max(1, Math.floor(options.maxLineBytes))
      : MAX_JSON_LINE_BYTES;
  socket.setEncoding('utf8');

  /**
   * @param {Error} error
   * @returns {void}
   */
  function fail(error) {
    options.onProtocolError?.(error);
    const destroy = /** @type {{ destroy?: (() => void) | undefined }} */ (socket).destroy;
    if (typeof destroy === 'function') {
      destroy.call(socket);
    }
  }

  /** @param {string} chunk */
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (!buffer.includes('\n') && Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
      fail(new Error(`JSON line exceeds ${maxLineBytes} bytes.`));
      return;
    }
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
        fail(new Error(`JSON line exceeds ${maxLineBytes} bytes.`));
        return;
      }
      try {
        onMessage(JSON.parse(line));
      } catch {
        // Malformed JSON line - skip it.
      }
    }
  });
}
