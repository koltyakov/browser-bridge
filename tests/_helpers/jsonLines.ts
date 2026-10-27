import { MAX_JSON_LINE_BYTES } from '../../protocol/src/defaults.js';

/** Install a newline-delimited JSON parser on a socket's `data` event. */
export function parseJsonLines(
  socket: import('node:net').Socket,
  onMessage: (message: unknown) => void,
  options: {
    maxLineBytes?: number;
    onProtocolError?: (error: Error) => void;
    onInvalidLine?: (error: Error) => void;
  } = {}
): void {
  let buffer = '';
  const maxLineBytes =
    typeof options.maxLineBytes === 'number' && Number.isFinite(options.maxLineBytes)
      ? Math.max(1, Math.floor(options.maxLineBytes))
      : MAX_JSON_LINE_BYTES;
  socket.setEncoding('utf8');

  function fail(error: Error): void {
    options.onProtocolError?.(error);
    const destroy = (socket as { destroy?: (() => void) | undefined }).destroy;
    if (typeof destroy === 'function') {
      destroy.call(socket);
    }
  }

  socket.on('data', (chunk: string) => {
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
      } catch (error) {
        // Malformed JSON line - skip it.
        options.onInvalidLine?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}
