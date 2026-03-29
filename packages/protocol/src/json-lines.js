// @ts-check

/**
 * Install a newline-delimited JSON parser on a socket's `data` event.
 *
 * @param {import('node:net').Socket} socket
 * @param {(message: unknown) => void} onMessage
 * @returns {void}
 */
export function parseJsonLines(socket, onMessage) {
  let buffer = '';
  socket.setEncoding('utf8');
  /** @param {string} chunk */
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      try {
        onMessage(JSON.parse(line));
      } catch {
        // Malformed JSON line - skip it.
      }
    }
  });
}
