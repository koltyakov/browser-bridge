// @ts-check

/** Injected into the tab's isolated world. Streaming enforces the decoded byte limit even without Content-Length.
 * @param {string} url @param {number} maxBytes @param {number} timeoutMs @param {string} [requestId]
 * @returns {Promise<{ data: string, mimeType: string, status: number } | { error: string }>} */
export async function fetchResourceInPage(url, maxBytes, timeoutMs, requestId = 'resource') {
  const controller = new AbortController();
  const scope =
    /** @type {typeof globalThis & { __BBX_RESOURCE_TASKS__?: Map<string, AbortController> }} */ (
      globalThis
    );
  const tasks = (scope.__BBX_RESOURCE_TASKS__ ??= new Map());
  if (tasks.size >= 4) return { error: 'Resource fetch limit reached.' };
  tasks.set(requestId, controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!response.ok) throw new Error(`Resource returned HTTP ${response.status}.`);
    const declaredSize = Number(response.headers.get('content-length'));
    if (declaredSize > maxBytes) throw new Error(`Resource exceeds maxBytes (${maxBytes}).`);
    const reader = response.body?.getReader();
    /** @type {Uint8Array[]} */
    const chunks = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > maxBytes) throw new Error(`Resource exceeds maxBytes (${maxBytes}).`);
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const parts = [];
    for (let index = 0; index < bytes.length; index += 32768)
      parts.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
    const suppliedType = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
    const mimeType =
      suppliedType.length <= 120 &&
      /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u.test(suppliedType)
        ? suppliedType
        : 'application/octet-stream';
    return { data: btoa(parts.join('')), mimeType, status: response.status };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    controller.abort();
    tasks.delete(requestId);
  }
}

/** Executed only in the isolated world on access cleanup. */
export function cancelPageResources() {
  const scope =
    /** @type {typeof globalThis & { __BBX_RESOURCE_TASKS__?: Map<string, AbortController> }} */ (
      globalThis
    );
  for (const controller of scope.__BBX_RESOURCE_TASKS__?.values() ?? []) controller.abort();
  scope.__BBX_RESOURCE_TASKS__?.clear();
}
