/** Acknowledged native messages bound streaming memory and surface disk errors. */
export function createJournalTransport(getPort: () => chrome.runtime.Port | null) {
  const waiting: Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  > = new Map();

  function send(
    action: 'begin' | 'append',
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
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

  function handle(input: unknown) {
    if (!input || typeof input !== 'object') return false;
    const message = input as Record<string, unknown>;
    if (message.type !== 'host.journal.ack') return false;
    const pending = waiting.get(String(message.messageId));
    if (!pending) return true;
    waiting.delete(String(message.messageId));
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(String(message.error)));
    else pending.resolve(message.result as Record<string, unknown>);
    return true;
  }
  function disconnect() {
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Journal transport disconnected.'));
    }
    waiting.clear();
  }

  async function begin(requestId: string) {
    const started = await send('begin', { requestId });
    const journalId = String(started.journalId);
    let offset = 0;
    return {
      journalId,

      async append(record: Record<string, unknown>) {
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
