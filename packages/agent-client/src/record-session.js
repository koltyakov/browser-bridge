// @ts-check

/** Retain one connection for capture, export, and artifact retrieval.
 * @param {(method: import('../../protocol/src/types.js').BridgeMethod, params: Record<string, unknown>) => Promise<import('../../protocol/src/types.js').BridgeResponse>} call
 * @param {Record<string, unknown>} options
 * @param {'json' | 'html'} format
 * @param {(artifact: import('../../protocol/src/types.js').ArtifactDescriptor) => Promise<void>} save
 * @param {(result: Record<string, unknown>) => void} [started]
 */
export async function recordSession(call, options, format, save, started = () => {}) {
  /** @param {import('../../protocol/src/types.js').BridgeMethod} method @param {Record<string, unknown>} params */
  async function invoke(method, params) {
    const response = await call(method, params);
    if (!response.ok) throw new Error(response.error.message);
    return /** @type {Record<string, unknown>} */ (response.result);
  }
  const initial = await invoke('session.start', options);
  const sessionId = String(initial.sessionId);
  started(initial);
  try {
    let cursor = Number(initial.nextCursor);
    while (true) {
      const next = await invoke('session.read', { sessionId, cursor, limit: 100, waitMs: 25000 });
      cursor = Number(next.nextCursor);
      if (!next.active) break;
    }
    const exported = await invoke('session.export', { sessionId, format });
    await save(
      /** @type {import('../../protocol/src/types.js').ArtifactDescriptor} */ (exported.artifact)
    );
    return { sessionId, gaps: exported.gaps, dropped: exported.dropped };
  } finally {
    await call('session.release', { sessionId }).catch(() => {});
  }
}
