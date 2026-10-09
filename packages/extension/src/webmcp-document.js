// @ts-check

/**
 * Injected into Chrome's ISOLATED world. Keep this function self-contained:
 * extension-owned references must never live in the page's MAIN-world globals.
 * No polyfills, legacy testing APIs, or automatic argument-format retries.
 * @param {string} method
 * @param {import('../../protocol/src/types.js').WebMcpParams} params
 * @param {string} owner
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runWebMcpInDocument(method, params, owner) {
  const isolated =
    /** @type {typeof globalThis & { __bbxWebMcp?: import('../../protocol/src/types.js').WebMcpDocumentState }} */ (
      globalThis
    );
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  const failure = (code, message, details = {}) => ({ error: { code, message, details } });
  let state = isolated.__bbxWebMcp;
  if (method === 'clear') {
    state?.invalidate();
    state?.active?.abort();
    return { cleared: true };
  }
  const context =
    /** @type {Document & { modelContext?: import('../../protocol/src/types.js').WebMcpContext }} */ (
      document
    ).modelContext;
  if (
    !context ||
    typeof context.getTools !== 'function' ||
    typeof context.executeTool !== 'function'
  ) {
    return method === 'webmcp.list_tools'
      ? {
          supported: false,
          api: 'document.modelContext',
          scope: 'top-document',
          tools: [],
          total: 0,
        }
      : failure(
          'WEBMCP_UNAVAILABLE',
          'The current WebMCP consumer API is unavailable in this document.'
        );
  }
  if (!state || state.context !== context) {
    state?.invalidate();
    state?.active?.abort();
    const next = {
      documentId: `doc_${crypto.randomUUID()}`,
      revision: 0,
      context,
      refs: new Map(),
      active: null,
      invalidate() {
        this.refs.clear();
        this.revision += 1;
      },
    };
    state = /** @type {import('../../protocol/src/types.js').WebMcpDocumentState} */ (next);
    isolated.__bbxWebMcp = state;
    context.addEventListener('toolchange', () => next.invalidate());
    window.addEventListener('pagehide', () => {
      next.invalidate();
      isolated.__bbxWebMcp?.active?.abort();
    });
    window.addEventListener('pageshow', () => next.invalidate());
  }
  const current = state;
  const startRevision = current.revision;
  /** @param {unknown} value */
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let discoveryTimer;
  /** @type {import('../../protocol/src/types.js').WebMcpDescriptor[]} */
  let tools;
  try {
    tools = await Promise.race([
      context.getTools(),
      new Promise((_, reject) => {
        discoveryTimer = setTimeout(() => reject(new Error('Discovery deadline exceeded.')), 5000);
      }),
    ]);
    if (!Array.isArray(tools) || tools.length > 1000)
      return failure('RESULT_TOO_LARGE', 'WebMCP catalog exceeds 1000 tools.');
    tools = tools.filter((tool) => tool.window === window);
  } catch {
    return failure('WEBMCP_UNAVAILABLE', 'WebMCP discovery failed or exceeded its deadline.');
  } finally {
    clearTimeout(discoveryTimer);
  }
  if (startRevision !== current.revision)
    return failure('WEBMCP_TOOL_STALE', 'The tool catalog changed during discovery.');
  /** @param {import('../../protocol/src/types.js').WebMcpDescriptor} tool */
  const metadata = (tool) => {
    if (
      typeof tool.name !== 'string' ||
      tool.name.length > 256 ||
      [...tool.name].some((character) => {
        const code = character.charCodeAt(0);
        return (
          code < 32 ||
          (code >= 127 && code <= 159) ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
        );
      }) ||
      typeof tool.description !== 'string' ||
      typeof tool.origin !== 'string'
    ) {
      throw new Error('Invalid tool metadata.');
    }
    /** @type {Record<string, boolean>} */
    const annotations = {};
    for (const key of ['readOnlyHint', 'consequentialHint', 'untrustedContentHint', 'debugging']) {
      if (typeof tool.annotations?.[key] === 'boolean') annotations[key] = tool.annotations[key];
    }
    return {
      name: tool.name,
      title: typeof tool.title === 'string' ? tool.title : '',
      description: tool.description,
      origin: tool.origin,
      annotations,
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    };
  };
  try {
    const now = Date.now();
    for (const [ref, entry] of current.refs) {
      if (entry.expiresAt < now) current.refs.delete(ref);
    }
    if (method === 'webmcp.list_tools') {
      const filtered = tools.filter(
        (tool) =>
          (params.includeDebugging || !tool.annotations?.debugging) &&
          (!params.query ||
            `${tool.name} ${tool.description}`.toLowerCase().includes(params.query.toLowerCase()))
      );
      /** @type {Record<string, unknown>[]} */
      const summaries = [];
      const catalog = {
        supported: true,
        api: 'document.modelContext',
        scope: 'top-document',
        documentId: current.documentId,
        revision: current.revision,
        total: filtered.length,
      };
      for (const descriptor of filtered.slice(params.offset, params.offset + params.limit)) {
        const full = metadata(descriptor);
        const fingerprint = JSON.stringify(full);
        if (bytes(full) > 262144)
          return failure('RESULT_TOO_LARGE', 'A tool descriptor exceeds the catalog safety limit.');
        let toolRef = [...current.refs].find(
          ([, entry]) => entry.owner === owner && entry.fingerprint === fingerprint
        )?.[0];
        if (!toolRef) {
          toolRef = `wm_${crypto.randomUUID()}`;
          if (current.refs.size >= 256) current.refs.delete(current.refs.keys().next().value ?? '');
          current.refs.set(toolRef, {
            tool: { ...full, toolRef },
            fingerprint,
            expiresAt: now + 300000,
            owner,
          });
        }
        const { inputSchema: _schema, ...summary } = full;
        const item = {
          ...summary,
          toolRef,
          description: full.description.slice(0, 400),
          title: full.title.slice(0, 100),
          schemaAvailable: full.inputSchema !== undefined,
          metadataTruncated: full.description.length > 400 || full.title.length > 100,
        };
        if (
          bytes({
            ...catalog,
            tools: [...summaries, item],
            truncated: true,
            nextOffset: params.offset + summaries.length + 1,
          }) > params.maxBytes
        ) {
          if (!summaries.length)
            return failure(
              'RESULT_TOO_LARGE',
              'One complete tool summary exceeds maxBytes. Increase the discovery budget.'
            );
          break;
        }
        summaries.push(item);
      }
      const nextOffset = params.offset + summaries.length;
      return {
        ...catalog,
        tools: summaries,
        truncated: nextOffset < filtered.length,
        nextOffset: nextOffset < filtered.length ? nextOffset : null,
      };
    }
    const ref = params.toolRef ?? '';
    const entry = current.refs.get(ref);
    const candidates = entry
      ? tools.filter((tool) => tool.name === entry.tool.name && tool.origin === entry.tool.origin)
      : [];
    const descriptor = candidates[0];
    if (
      !entry ||
      entry.owner !== owner ||
      candidates.length !== 1 ||
      !descriptor ||
      JSON.stringify(metadata(descriptor)) !== entry.fingerprint
    ) {
      current.refs.delete(ref);
      return failure('WEBMCP_TOOL_STALE', 'The tool reference is missing, expired, or changed.');
    }
    if (method === 'webmcp.get_tool') {
      const result = {
        documentId: current.documentId,
        revision: current.revision,
        tool: entry.tool,
      };
      return bytes(result) <= params.maxBytes
        ? result
        : failure('RESULT_TOO_LARGE', 'The complete tool schema exceeds maxBytes.');
    }
    if (method !== 'webmcp.execute_tool')
      return failure('INVALID_REQUEST', 'Unknown WebMCP operation.');
    if (current.active) return failure('WEBMCP_BUSY', 'A callback may still be running.');
    // Revalidation and invocation are adjacent, but WebMCP does not guarantee
    // atomic registration identity. Never recover by invoking a replacement.
    if (current.revision !== startRevision)
      return failure('WEBMCP_TOOL_STALE', 'The catalog changed before dispatch.');
    const controller = new AbortController();
    current.active = controller;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    let timedOut = false;
    let aborted = false;
    let started = false;
    const startedAt = Date.now();
    try {
      const operation = Promise.resolve(
        context.executeTool(descriptor, params.arguments, { signal: controller.signal })
      );
      started = true;
      void operation
        .finally(() => {
          if (current.active === controller) current.active = null;
        })
        .catch(() => {});
      const cancelled = new Promise((resolve) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve(undefined);
          },
          { once: true }
        );
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, params.timeoutMs);
      });
      const value = await Promise.race([operation, cancelled]);
      if (aborted)
        return {
          status: timedOut ? 'timeout' : 'cancelled',
          dispatched: true,
          outcome: 'uncertain',
          documentId: current.documentId,
          durationMs: Date.now() - startedAt,
        };
      const result = {
        status: value === null ? 'navigation' : 'completed',
        dispatched: true,
        outcome: value === null ? 'uncertain' : 'completed',
        documentId: current.documentId,
        durationMs: Date.now() - startedAt,
        value,
      };
      if (bytes(result) > params.maxBytes)
        return failure(
          'RESULT_TOO_LARGE',
          'Tool executed, but its complete result exceeds maxBytes. Do not replay.',
          { dispatched: true, outcome: 'completed' }
        );
      return JSON.parse(JSON.stringify(result));
    } catch {
      return failure(
        'WEBMCP_EXECUTION_UNCERTAIN',
        'The callback rejected or returned a non-serializable result. Inspect postconditions; do not replay.',
        { dispatched: true, outcome: 'uncertain' }
      );
    } finally {
      clearTimeout(timer);
      if (!started && current.active === controller) current.active = null;
    }
  } catch {
    return failure('WEBMCP_UNAVAILABLE', 'Invalid or non-serializable WebMCP tool metadata.');
  }
}
