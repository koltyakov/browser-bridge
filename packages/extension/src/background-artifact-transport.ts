import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';

/** One acknowledged chunk per uploader bounds native messaging's hidden queue.
 * Acknowledgement means the daemon finished validating and writing the chunk. */
export function createArtifactTransport(getPort: () => chrome.runtime.Port | null) {
  const waiting = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  function send(message: Record<string, unknown>): Promise<void> {
    const port = getPort();
    if (!port)
      return Promise.reject(
        new BridgeError(ERROR_CODES.EXTENSION_DISCONNECTED, 'Native host disconnected.')
      );
    if (waiting.size >= 4)
      return Promise.reject(
        new BridgeError(
          ERROR_CODES.ARTIFACT_QUOTA_EXCEEDED,
          'At most four artifact transfers may write concurrently.'
        )
      );
    const messageId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(messageId);
        reject(new BridgeError(ERROR_CODES.TIMEOUT, 'Artifact acknowledgement timed out.'));
      }, 5000);
      waiting.set(messageId, { resolve, reject, timer });
      try {
        port.postMessage({ ...message, messageId });
      } catch (error) {
        clearTimeout(timer);
        waiting.delete(messageId);
        reject(error);
      }
    });
  }
  function handle(input: unknown): boolean {
    if (
      !input ||
      typeof input !== 'object' ||
      !('type' in input) ||
      input.type !== 'host.artifact.ack'
    )
      return false;
    const message = input as Record<string, unknown>;
    const pending = waiting.get(String(message.messageId));
    if (!pending) return true;
    waiting.delete(String(message.messageId));
    clearTimeout(pending.timer);
    if (message.error)
      pending.reject(new BridgeError(ERROR_CODES.ARTIFACT_TRANSFER_INVALID, String(message.error)));
    else pending.resolve();
    return true;
  }
  function disconnect() {
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new BridgeError(ERROR_CODES.EXTENSION_DISCONNECTED, 'Artifact transport disconnected.')
      );
    }
    waiting.clear();
  }
  return { send, handle, disconnect };
}
