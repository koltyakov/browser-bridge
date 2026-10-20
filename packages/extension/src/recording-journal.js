// @ts-check

/** Acknowledged native messages bound streaming memory and surface disk errors.
 * @param {() => chrome.runtime.Port | null} getPort */
export function createJournalTransport(getPort) {
  /** @type {Map<string, { resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
  const waiting = new Map();
  /** @param {'begin' | 'append'} action @param {Record<string, unknown>} params @returns {Promise<Record<string, unknown>>} */
  function send(action, params) {
    const port = getPort();
    if (!port) return Promise.reject(new Error('Native host disconnected.'));
    const messageId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(messageId);
        reject(new Error('Journal acknowledgement timed out.'));
      }, 5000);
      waiting.set(messageId, { resolve, reject, timer });
      try {
        port.postMessage({ type: `host.journal.${action}`, messageId, ...params });
      } catch (error) {
        clearTimeout(timer);
        waiting.delete(messageId);
        reject(error);
      }
    });
  }
  /** @param {unknown} input */
  function handle(input) {
    if (!input || typeof input !== 'object') return false;
    const message = /** @type {Record<string, unknown>} */ (input);
    if (message.type !== 'host.journal.ack') return false;
    const pending = waiting.get(String(message.messageId));
    if (!pending) return true;
    waiting.delete(String(message.messageId));
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(String(message.error)));
    else pending.resolve(/** @type {Record<string, unknown>} */ (message.result));
    return true;
  }
  function disconnect() {
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Journal transport disconnected.'));
    }
    waiting.clear();
  }
  /** @param {string} requestId */
  async function begin(requestId) {
    const started = await send('begin', { requestId });
    const journalId = String(started.journalId);
    let offset = 0;
    return {
      journalId,
      /** @param {Record<string, unknown>} record */
      async append(record) {
        const bytes = new TextEncoder().encode(JSON.stringify(record) + '\n');
        for (let i = 0; i < bytes.length; i += 196608) {
          const chunk = bytes.subarray(i, i + 196608);
          let binary = '';
          for (let j = 0; j < chunk.length; j += 32768)
            binary += String.fromCharCode(...chunk.subarray(j, j + 32768));
          const ack = await send('append', { journalId, offset, data: btoa(binary) });
          if (ack.nextOffset !== offset + chunk.length)
            throw new Error('Invalid journal acknowledgement.');
          offset += chunk.length;
        }
      },
    };
  }
  return { begin, handle, disconnect };
}
