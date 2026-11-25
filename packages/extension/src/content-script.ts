(() => {
  const contentScriptGlobal = globalThis as typeof globalThis & {
    __chromeCodexBridgeContentScriptLoaded?: boolean;
  };
  if (contentScriptGlobal.__chromeCodexBridgeContentScriptLoaded) {
    return;
  }

  const runtimeOnMessage =
    typeof chrome !== 'undefined' &&
    chrome?.runtime?.onMessage &&
    typeof chrome.runtime.onMessage.addListener === 'function'
      ? chrome.runtime.onMessage
      : null;
  if (!runtimeOnMessage) {
    return;
  }

  const contentHelpers = (
    globalThis as typeof globalThis & { __BBX_CONTENT_HELPERS__?: Record<string, unknown> }
  ).__BBX_CONTENT_HELPERS__;
  if (!contentHelpers) {
    throw new Error('Browser Bridge content-script helpers must load before content-script.js.');
  }

  const registry = (
    globalThis as typeof globalThis & { __BBX_CONTENT_REGISTRY__?: Record<string, unknown> }
  ).__BBX_CONTENT_REGISTRY__;
  if (!registry) {
    throw new Error('Browser Bridge content-element-registry must load before content-script.js.');
  }

  const domBaseline = (
    globalThis as typeof globalThis & {
      __bbxContentDomBaseline?: { capture: (params: Record<string, unknown>) => unknown };
    }
  ).__bbxContentDomBaseline;
  if (!domBaseline) {
    throw new Error('Browser Bridge content-dom-baseline must load before content-script.js.');
  }
  const baselineModule = domBaseline;

  type DomQueryModule = {
    describeElement: (ref: string) => unknown;
    domQuery: (params: Record<string, unknown>) => unknown;
    findByRole: (params: Record<string, unknown>) => unknown;
    findByText: (params: Record<string, unknown>) => unknown;
    getAccessibilityOutline: (params: Record<string, unknown>) => unknown;
    clearOutlineSnapshots: () => unknown;
    probeTarget: (params: Record<string, unknown>) => { found: boolean };
    getAttributes: (ref: string, attrs: string[]) => unknown;
    getBoxModel: (ref: string) => unknown;
    getComputedStyles: (ref: string, properties?: string[]) => unknown;
    getHtml: (params: Record<string, unknown>) => unknown;
    getMatchedRules: (ref: string) => unknown;
    getText: (ref: string, budget?: number, offset?: number) => unknown;
    hitTest: (x: number, y: number) => unknown;
    summarizeNode: (
      element: Element,
      attrs: string[],
      budget: number,
      bbox: boolean
    ) => {
      node: NodeSummary;
      textLength: number;
    };
    waitForDom: (params: Record<string, unknown>) => unknown;
  };

  type InputModule = {
    beginNativeObservation: () => { observationId: string };
    getTrustHint: (params: Record<string, unknown>) => {
      needsTrusted: boolean;
      reason: string | null;
    };
    finishNativeObservation: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    clickTarget: (params: Record<string, unknown>) => unknown;
    dragTarget: (params: Record<string, unknown>) => unknown;
    fillTarget: (params: Record<string, unknown>) => unknown;
    focusTarget: (params: Record<string, unknown>) => unknown;
    hoverTarget: (params: Record<string, unknown>) => unknown;
    prepareNativeInput: (params: Record<string, unknown>) => unknown;
    revalidateNativeInput: (params: Record<string, unknown>) => unknown;
    readInputValue: (params: Record<string, unknown>) => unknown;
    pressKeyTarget: (params: Record<string, unknown>) => unknown;
    scrollIntoViewTarget: (params: Record<string, unknown>) => unknown;
    scrollViewport: (params: Record<string, unknown>) => unknown;
    getScrollContainerDetection: () => import('../../../protocol/src/types.js').ScrollContainerDetection;
    selectOptionTarget: (params: Record<string, unknown>) => unknown;
    setCheckedTarget: (params: Record<string, unknown>) => unknown;
    touchTarget: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    typeIntoTarget: (params: Record<string, unknown>) => unknown;
  };

  type PatchModule = {
    applyStylePatch: (params: Record<string, unknown>) => unknown;
    applyDomPatch: (params: Record<string, unknown>) => unknown;
    commitSessionBaseline: () => { committed: true };
    listPatches: () => unknown;
    rollbackPatch: (patchId: string) => unknown;
  };

  const domQueryModule = (
    globalThis as typeof globalThis & { __BBX_CONTENT_DOM_QUERY__?: DomQueryModule }
  ).__BBX_CONTENT_DOM_QUERY__ as DomQueryModule;
  const inputModule = (globalThis as typeof globalThis & { __BBX_CONTENT_INPUT__?: InputModule })
    .__BBX_CONTENT_INPUT__ as InputModule;
  const patchModule = (globalThis as typeof globalThis & { __BBX_CONTENT_PATCH__?: PatchModule })
    .__BBX_CONTENT_PATCH__ as PatchModule;

  type TextWindow = {
    value: string;
    truncated: boolean;
    omitted: number;
    length: number;
    offset?: number;
    nextOffset?: number;
  };
  const { truncateText, getVisibleText, readTextWindow } = contentHelpers as {
    truncateText: (
      value: string,
      budget: number
    ) => { value: string; truncated: boolean; omitted: number };
    getVisibleText: (root: Element, maxChars?: number) => string;
    readTextWindow: (text: string, budget: number, offset?: number) => TextWindow;
  };
  const { getRequiredElement, resolveElementRefFromParams } = registry as {
    getRequiredElement: (ref: string) => Element;
    resolveElementRefFromParams: (params?: Record<string, unknown>) => string;
  };

  type NodeSummary = {
    elementRef: string;
    tag: string;
    role: string | null;
    name: string | null;
    textExcerpt: string;
    attrs: Record<string, string | null>;
    bbox?: { x: number; y: number; width: number; height: number };
  };

  contentScriptGlobal.__chromeCodexBridgeContentScriptLoaded = true;
  const activeRequests = new Map<string, AbortController>();

  runtimeOnMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'bridge.ping') {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'bridge.cancel') {
      activeRequests.get(String(message.requestId))?.abort();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== 'bridge.execute') {
      return false;
    }

    const id = typeof message.requestId === 'string' ? message.requestId : '';
    const controller = new AbortController();
    if (id && activeRequests.size >= 128) {
      sendResponse({
        error: {
          code: 'BRIDGE_BUSY',
          message: 'The page is running 128 bridge requests, its limit. Retry shortly.',
          details: { retryAfterMs: 500 },
        },
      });
      return false;
    }
    if (id) activeRequests.set(id, controller);
    const assertActive = () => {
      if (
        controller.signal.aborted ||
        (typeof message.deadlineMs === 'number' && Date.now() >= message.deadlineMs)
      )
        throw Object.assign(
          new Error('Content request canceled or expired. Inspect postconditions before retrying.'),
          { code: 'TIMEOUT' }
        );
    };
    const finish = () => {
      if (activeRequests.get(id) === controller) activeRequests.delete(id);
    };
    try {
      assertActive();
      const result = handleCommand(message.method, {
        ...message.params,
        __bbxAssertActive: assertActive,
        ...(typeof message.activityChannel === 'string'
          ? { __bbxActivityChannel: message.activityChannel }
          : {}),
        ...(message.method === 'dom.wait_for'
          ? { __bbxSignal: controller.signal, __bbxWatchFrameTree: message.watchFrameTree === true }
          : {}),
      });
      Promise.resolve(result)
        .then(sendResponse)
        .catch((err) => {
          sendResponse({
            error: serializeContentError(err),
          });
        })
        .finally(finish);
    } catch (error) {
      finish();
      sendResponse({
        error: serializeContentError(error),
      });
    }

    return true;
  });

  /** Read options normalized by the background before dispatch to this script. */
  type ContentCommandParams = Record<string, unknown> & {
    textBudget?: number;
    attributes?: string[];
    properties?: string[];
  };

  /** Dispatch a bridge method within the page context. */
  function handleCommand(method: string, params: ContentCommandParams): unknown {
    switch (method) {
      case 'page.get_state':
        return getPageState();
      case 'page.get_storage':
        return params.type === 'indexeddb' ? getIndexedDbMetadata() : getStorageData(params);
      case 'sensitive.read':
        return getSensitiveStorageValue(params);
      // Internal: the background sends this only after the sensitive-data gate.
      case 'indexeddb.read_record':
        return readIndexedDbRecord(params);
      case 'page.get_text':
        return getFullPageText(params);
      case 'navigation.navigate':
      case 'navigation.reload':
      case 'navigation.go_back':
      case 'navigation.go_forward':
        throw new Error(`Unsupported content-script method ${method}`);
      case 'dom.query':
        return domQueryModule.domQuery(params);
      case 'dom.baseline.snapshot':
        return baselineModule.capture(params);
      case 'dom.describe':
        return domQueryModule.describeElement(resolveElementRefFromParams(params));
      case 'dom.get_text':
        return domQueryModule.getText(
          resolveElementRefFromParams(params),
          params.textBudget,
          Number(params.offset) || 0
        );
      case 'dom.get_attributes':
        return domQueryModule.getAttributes(
          resolveElementRefFromParams(params),
          params.attributes ?? []
        );
      case 'dom.wait_for':
        return domQueryModule.waitForDom(params);
      case 'dom.find_by_text':
        return domQueryModule.findByText(params);
      case 'dom.find_by_role':
        return domQueryModule.findByRole(params);
      case 'dom.get_accessibility_tree':
        return domQueryModule.getAccessibilityOutline(params);
      case 'dom.outline.clear':
        return domQueryModule.clearOutlineSnapshots();
      case 'dom.probe_target':
        return domQueryModule.probeTarget(params);
      case 'dom.get_html':
        return domQueryModule.getHtml({
          ...params,
          elementRef: resolveElementRefFromParams(params),
        });
      case 'layout.get_box_model':
        return domQueryModule.getBoxModel(resolveElementRefFromParams(params));
      case 'layout.hit_test':
        return domQueryModule.hitTest(Number(params.x), Number(params.y));
      case 'styles.get_computed':
        return domQueryModule.getComputedStyles(
          resolveElementRefFromParams(params),
          params.properties
        );
      case 'styles.get_matched_rules':
        return domQueryModule.getMatchedRules(resolveElementRefFromParams(params));
      case 'viewport.scroll':
        return inputModule.scrollViewport(params);
      case 'input.click':
        return inputModule.clickTarget(params);
      case 'input.focus':
        return inputModule.focusTarget(params);
      case 'input.type':
        return inputModule.typeIntoTarget(params);
      case 'input.fill':
        return inputModule.fillTarget(params);
      case 'input.press_key':
        return inputModule.pressKeyTarget(params);
      case 'input.set_checked':
        return inputModule.setCheckedTarget(params);
      case 'input.select_option':
        return inputModule.selectOptionTarget(params);
      case 'input.hover':
        return inputModule.hoverTarget(params);
      case 'input.drag':
        return inputModule.dragTarget(params);
      case 'input.touch':
        return inputModule.touchTarget(params);
      case 'input.resolve_native':
        return inputModule.prepareNativeInput(params);
      case 'input.trust_hint':
        return inputModule.getTrustHint(params);
      case 'input.observe_start':
        return inputModule.beginNativeObservation();
      case 'input.observe_finish':
        return inputModule.finishNativeObservation(params);
      case 'input.revalidate_native':
        return inputModule.revalidateNativeInput(params);
      case 'input.read_value':
        return inputModule.readInputValue(params);
      case 'input.scroll_into_view':
        return inputModule.scrollIntoViewTarget(params);
      case 'patch.apply_styles':
        return patchModule.applyStylePatch(params);
      case 'patch.apply_dom':
        return patchModule.applyDomPatch(params);
      case 'patch.list':
        return patchModule.listPatches();
      case 'patch.rollback':
        return patchModule.rollbackPatch(String(params.patchId));
      case 'patch.commit_session_baseline':
        return patchModule.commitSessionBaseline();
      case 'screenshot.capture_element':
        return getElementRect(resolveElementRefFromParams(params));
      case 'screenshot.capture_full_page':
        return getFullPageDimensions();
      default:
        throw new Error(`Unsupported method ${method}`);
    }
  }

  /** Preserve structured input resolution failures while retaining string
errors for older content operations. */
  function serializeContentError(
    error: unknown
  ): string | { code: string; message: string; details: unknown } {
    if (error && typeof error === 'object') {
      const candidate = error as {
        code?: unknown;
        name?: unknown;
        message?: unknown;
        details?: unknown;
      };
      if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
        return {
          code: candidate.code,
          message: candidate.message,
          details: candidate.details ?? null,
        };
      }
      // DOM selector syntax errors cannot recover on retry. Chrome's
      // DOMException.code is numeric, so it does not use the branch above.
      if (candidate.name === 'SyntaxError' && typeof candidate.message === 'string') {
        return { code: 'INVALID_REQUEST', message: candidate.message, details: null };
      }
    }
    return error instanceof Error ? error.message : String(error);
  }

  /** Return lightweight page state useful for browser automation decisions. */
  function getPageState(): {
    url: string;
    origin: string;
    title: string;
    readyState: DocumentReadyState;
    focused: boolean;
    viewport: { width: number; height: number; devicePixelRatio: number };
    scroll: {
      x: number;
      y: number;
      maxX: number;
      maxY: number;
    } & import('../../../protocol/src/types.js').ScrollContainerDetection;
    activeElement: NodeSummary | null;
    selection: { value: string; truncated: boolean; omitted: number };
    hints: { tailwind: boolean };
  } {
    const scrollingElement = document.scrollingElement || document.documentElement || document.body;
    const selection = document.getSelection?.()?.toString() || '';

    return {
      url: window.location.href,
      origin: window.location.origin,
      title: document.title,
      readyState: document.readyState,
      focused: document.hasFocus(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      scroll: {
        ...inputModule.getScrollContainerDetection(),
        x: window.scrollX,
        y: window.scrollY,
        maxX: Math.max(
          0,
          (scrollingElement?.scrollWidth || document.documentElement.scrollWidth || 0) -
            window.innerWidth
        ),
        maxY: Math.max(
          0,
          (scrollingElement?.scrollHeight || document.documentElement.scrollHeight || 0) -
            window.innerHeight
        ),
      },
      activeElement:
        document.activeElement instanceof Element
          ? domQueryModule.summarizeNode(
              document.activeElement,
              ['id', 'class', 'name', 'type', 'href', 'role'],
              120,
              true
            ).node
          : null,
      selection: truncateText(selection.trim(), 200),
      hints: detectPageHints(),
    };
  }

  /** Detect CSS frameworks and page characteristics for agent guidance.
Lightweight - only checks a few DOM/stylesheet signals. */
  function detectPageHints(): { tailwind: boolean } {
    let tailwind = false;
    try {
      tailwind = Boolean(
        document.querySelector(
          'link[href*="tailwind"], style[id*="tailwind"], script[src*="tailwindcss"]'
        )
      );
      if (!tailwind) {
        // Sample lazily instead of allocating every classed element on large
        // pages. Sparse class attributes must not cause an unbounded walk.
        const walker = document.createTreeWalker(document, 1);
        const twPattern =
          /\b(?:(?:flex|grid|rounded|shadow|border)(?:\s|$|-)|(?:bg|text|p[xytblr]?|m[xytblr]?|w|h)-)/;
        let sampled = 0;
        for (let visited = 0; visited < 2000 && sampled < 30; visited++) {
          const element = walker.nextNode() as Element | null;
          if (!element) break;
          if (!element.hasAttribute('class')) continue;
          sampled += 1;
          const cls = element.className;
          if (typeof cls === 'string' && twPattern.test(cls)) {
            tailwind = true;
            break;
          }
        }
      }
    } catch {
      // Ignore - cross-origin or other DOM access issues
    }
    return { tailwind };
  }

  /** Extract the visible text of the page, including shadow trees, from
`offset`. A truncated result names the `nextOffset` that continues it. */
  function getFullPageText(params: Record<string, unknown>): TextWindow {
    const budget = Number(params.textBudget) || 8000;
    const body = document.body;
    if (!body) {
      return { value: '', truncated: false, omitted: 0, length: 0 };
    }
    return readTextWindow(getVisibleText(body), budget, Number(params.offset) || 0);
  }

  /** Read localStorage or sessionStorage entries. */
  function getStorageData(params: Record<string, unknown>): {
    type: string;
    entries: Array<{ key: string; present: boolean }>;
    count: number;
    total: number;
    truncated: boolean;
  } {
    if (params.type !== undefined && params.type !== 'local' && params.type !== 'session') {
      throw {
        code: 'INVALID_REQUEST',
        message: 'The content script lists only local and session storage keys here.',
        details: { reason: 'unsupported_storage_type' },
      };
    }
    const type = params.type === 'session' ? 'session' : 'local';
    const storage = type === 'session' ? sessionStorage : localStorage;
    const keys = Array.isArray(params.keys)
      ? params.keys.filter((k) => typeof k === 'string')
      : null;

    const entries: Array<{ key: string; present: boolean }> = [];
    if (keys) {
      for (const key of keys) {
        entries.push({ key, present: storage.getItem(key) !== null });
      }
    } else {
      for (let i = 0; i < Math.min(storage.length, 100); i++) {
        const key = storage.key(i);
        if (key !== null) {
          entries.push({ key, present: true });
        }
      }
    }
    return {
      type,
      entries,
      count: entries.length,
      total: storage.length,
      truncated: keys === null && entries.length < storage.length,
    };
  }

  /** Deliberately return one exact Web Storage value or reject it atomically. */
  function getSensitiveStorageValue(params: Record<string, unknown>): {
    source: 'local_storage' | 'session_storage';
    value: string;
    exact: true;
  } {
    // Only Web Storage is read here. Any other source is handled, and gated, in
    // the background; never fall back to localStorage for an unknown source.
    if (params.source !== 'local_storage' && params.source !== 'session_storage') {
      throw {
        code: 'INVALID_REQUEST',
        message: 'The content script reads only local_storage and session_storage.',
        details: { reason: 'unsupported_source' },
      };
    }
    const source = params.source;
    const storage = source === 'session_storage' ? sessionStorage : localStorage;
    const key = typeof params.key === 'string' ? params.key : '';
    const value = storage.getItem(key);
    if (value === null) {
      throw {
        code: 'SENSITIVE_TARGET_NOT_FOUND',
        message: `No ${source === 'session_storage' ? 'session' : 'local'} storage value exists for the requested key.`,
        details: { source, keyLength: key.length },
      };
    }
    const bytes = new TextEncoder().encode(value).byteLength;
    const maxBytes = typeof params.maxBytes === 'number' ? params.maxBytes : 262_144;
    if (bytes > maxBytes) {
      throw {
        code: 'RESULT_TOO_LARGE',
        message: `The exact storage value is too large to return atomically (${bytes} bytes).`,
        details: {
          source,
          characters: value.length,
          bytes,
          maxBytes,
          guidance: 'Use a narrower exact target; partial sensitive values are never returned.',
        },
      };
    }
    return { source, value, exact: true };
  }

  // IndexedDB. This runs in the frame's own document, so it sees exactly the
  // storage that origin sees in this tab's partition. Rules: open only names
  // indexedDB.databases() reported, never pass a version, close at once, and
  // close on versionchange so the page's own upgrade is never blocked.
  const IDB_MAX_DATABASES = 20;
  const IDB_MAX_STORES = 50;
  const IDB_MAX_INDEXES = 20;
  const IDB_WALK_BUDGET_MS = 2_000;
  const IDB_OPEN_TIMEOUT_MS = 1_000;
  const IDB_READ_TIMEOUT_MS = 1_500;
  const IDB_MAX_DESCRIBE_NODES = 50_000;
  const IDB_MAX_DESCRIBE_DEPTH = 64;

  type IdbOpenOutcome =
    | { db: IDBDatabase }
    | { error: 'open_timeout' | 'database_missing' | 'open_failed' };

  const IDB_TIMEOUT: unique symbol = Symbol('idb-timeout');
  const IDB_TOO_LARGE: unique symbol = Symbol('idb-too-large');

  /** Resolve a promise or report a timeout; the work itself is not canceled. */
  function idbWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof IDB_TIMEOUT> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(IDB_TIMEOUT), Math.max(0, timeoutMs));
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = (event) => {
        event.preventDefault();
        reject(request.error);
      };
    });
  }

  /** Open an existing database without a version. A late success after the
   * timeout is closed immediately, and a missing database is never created:
   * upgradeneeded only fires for a name that no longer exists, and aborting
   * that upgrade transaction leaves nothing behind. */
  function openExistingDatabase(name: string, timeoutMs: number): Promise<IdbOpenOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let missing = false;
      const finish = (outcome: IdbOpenOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(name);
      } catch {
        resolve({ error: 'open_failed' });
        return;
      }
      const timer = setTimeout(() => finish({ error: 'open_timeout' }), Math.max(0, timeoutMs));
      request.onupgradeneeded = () => {
        missing = true;
        try {
          request.transaction?.abort();
        } catch {
          // The open then fails with AbortError; nothing is committed.
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        if (settled || missing) {
          db.close();
          finish({ error: missing ? 'database_missing' : 'open_timeout' });
          return;
        }
        finish({ db });
      };
      request.onerror = (event) => {
        event.preventDefault();
        finish({ error: missing ? 'database_missing' : 'open_failed' });
      };
      // blocked fires only for version changes, which BBX never requests.
      request.onblocked = () => {};
    });
  }

  function idbKeyPath(value: unknown): string | string[] | null {
    if (typeof value === 'string') return value;
    if (value && typeof (value as ArrayLike<string>).length === 'number')
      return Array.from(value as ArrayLike<string>, String);
    return null;
  }

  function listIndexedDbDatabases(timeoutMs: number) {
    const factory = typeof indexedDB === 'undefined' ? null : indexedDB;
    if (!factory || typeof factory.databases !== 'function') return null;
    return idbWithin(factory.databases(), timeoutMs);
  }

  /** Database, store, and index metadata for this frame's origin. Record
   * counts and the whole walk are bounded by time and by size. */
  async function getIndexedDbMetadata(): Promise<Record<string, unknown>> {
    const started = Date.now();
    const remaining = () => IDB_WALK_BUDGET_MS - (Date.now() - started);
    const incomplete = new Set<string>();
    const databases: Array<Record<string, unknown>> = [];
    const result = () => ({
      type: 'indexeddb',
      origin: location.origin,
      available,
      databases,
      total,
      incomplete: [...incomplete],
    });
    let available = true;
    let total = 0;
    let listed: Awaited<ReturnType<IDBFactory['databases']>> | typeof IDB_TIMEOUT;
    try {
      const pending = listIndexedDbDatabases(IDB_OPEN_TIMEOUT_MS);
      if (!pending) {
        available = false;
        return result();
      }
      listed = await pending;
    } catch {
      // Opaque origins and storage-blocked documents cannot use IndexedDB.
      available = false;
      return result();
    }
    if (listed === IDB_TIMEOUT) {
      incomplete.add('databases_timeout');
      return result();
    }
    const named = listed.filter((entry) => typeof entry?.name === 'string');
    total = named.length;
    if (named.length > IDB_MAX_DATABASES) incomplete.add('database_limit');
    for (const entry of named.slice(0, IDB_MAX_DATABASES)) {
      if (remaining() <= 0) {
        incomplete.add('time_budget');
        break;
      }
      const name = entry.name as string;
      const opened = await openExistingDatabase(name, Math.min(IDB_OPEN_TIMEOUT_MS, remaining()));
      if ('error' in opened) {
        databases.push({
          name,
          version: typeof entry.version === 'number' ? entry.version : 0,
          stores: [],
          storeCount: 0,
          error: opened.error,
        });
        incomplete.add('database_error');
        continue;
      }
      const db = opened.db;
      try {
        const storeNames = Array.from(db.objectStoreNames);
        if (storeNames.length > IDB_MAX_STORES) incomplete.add('store_limit');
        const selected = storeNames.slice(0, IDB_MAX_STORES);
        const stores: Array<Record<string, unknown>> = [];
        if (selected.length) {
          const transaction = db.transaction(selected, 'readonly');
          const counts: Array<Promise<number>> = [];
          for (const storeName of selected) {
            const store = transaction.objectStore(storeName);
            const indexNames = Array.from(store.indexNames).slice(0, IDB_MAX_INDEXES);
            stores.push({
              name: storeName,
              keyPath: idbKeyPath(store.keyPath),
              autoIncrement: store.autoIncrement === true,
              indexes: indexNames.map((indexName) => {
                const index = store.index(indexName);
                return {
                  name: indexName,
                  keyPath: idbKeyPath(index.keyPath) ?? '',
                  unique: index.unique === true,
                  multiEntry: index.multiEntry === true,
                };
              }),
              count: null,
            });
            counts.push(idbRequest(store.count()));
          }
          const settled = await idbWithin(
            Promise.all(counts.map((count) => count.catch(() => null))),
            Math.max(0, remaining())
          );
          if (settled === IDB_TIMEOUT) {
            incomplete.add('time_budget');
            try {
              transaction.abort();
            } catch {
              // Already finished.
            }
          } else {
            settled.forEach((count, index) => {
              stores[index].count = typeof count === 'number' ? count : null;
            });
          }
        }
        databases.push({ name, version: db.version, stores, storeCount: storeNames.length });
      } catch {
        databases.push({
          name,
          version: db.version,
          stores: [],
          storeCount: 0,
          error: 'open_failed',
        });
        incomplete.add('database_error');
      } finally {
        db.close();
      }
    }
    return result();
  }

  /** Convert an IndexedDbKey from JSON params to an IndexedDB key. */
  function toIndexedDbKey(value: unknown): IDBValidKey {
    const part = (item: unknown): IDBValidKey => {
      if (typeof item === 'string' || typeof item === 'number') return item;
      if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'date')
        return new Date(Number((item as { value?: unknown }).value));
      throw {
        code: 'INVALID_REQUEST',
        message: 'Unsupported IndexedDB key type.',
        details: { reason: 'unsupported_key_type' },
      };
    };
    return Array.isArray(value) ? value.map(part) : part(value);
  }

  /** Copy a structured-clone value to JSON. Values JSON cannot carry are
   * replaced in place by a {$bbxType} description; binary contents are never
   * copied. Returns null when the value is too large to walk. */
  function describeForJson(value: unknown): { json: unknown; described: number } | null {
    let nodes = 0;
    let described = 0;
    const ancestors: object[] = [];
    const tag = (item: object) => Object.prototype.toString.call(item).slice(8, -1);
    const mark = (description: Record<string, unknown>) => {
      described += 1;
      return description;
    };
    const walk = (item: unknown, depth: number): unknown => {
      nodes += 1;
      if (nodes > IDB_MAX_DESCRIBE_NODES) throw IDB_TOO_LARGE;
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
      if (typeof item === 'number')
        return Number.isFinite(item) ? item : mark({ $bbxType: 'Number', value: String(item) });
      if (typeof item === 'undefined') return mark({ $bbxType: 'undefined' });
      if (typeof item === 'bigint') return mark({ $bbxType: 'BigInt', value: item.toString() });
      if (typeof item !== 'object') return mark({ $bbxType: typeof item });
      if (depth >= IDB_MAX_DESCRIBE_DEPTH) return mark({ $bbxType: 'DepthLimit' });
      if (ancestors.includes(item)) return mark({ $bbxType: 'Circular' });
      const kind = tag(item);
      if (kind === 'Blob' || kind === 'File') {
        const blob = item as Blob;
        return mark({ $bbxType: kind, mimeType: blob.type, size: blob.size });
      }
      if (kind === 'ArrayBuffer' || kind === 'SharedArrayBuffer')
        return mark({ $bbxType: kind, byteLength: (item as ArrayBuffer).byteLength });
      if (ArrayBuffer.isView(item))
        return mark({ $bbxType: kind, byteLength: (item as ArrayBufferView).byteLength });
      if (kind === 'Date') {
        const time = (item as Date).getTime();
        return mark({
          $bbxType: 'Date',
          value: Number.isFinite(time) ? (item as Date).toISOString() : null,
        });
      }
      if (kind === 'Map' || kind === 'Set')
        return mark({ $bbxType: kind, size: (item as Map<unknown, unknown>).size });
      if (kind === 'FileList') return mark({ $bbxType: kind, length: (item as FileList).length });
      if (kind === 'String' || kind === 'Number' || kind === 'Boolean')
        return mark({ $bbxType: kind, value: (item as { valueOf: () => unknown }).valueOf() });
      if (kind !== 'Object' && kind !== 'Array') return mark({ $bbxType: kind });
      ancestors.push(item);
      try {
        if (Array.isArray(item)) {
          const out: unknown[] = [];
          for (let index = 0; index < item.length; index += 1)
            out.push(walk(item[index], depth + 1));
          return out;
        }
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(item))
          Object.defineProperty(out, key, {
            value: walk((item as Record<string, unknown>)[key], depth + 1),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        return out;
      } finally {
        ancestors.pop();
      }
    };
    try {
      return { json: walk(value, 0), described };
    } catch (error) {
      if (error === IDB_TOO_LARGE) return null;
      throw error;
    }
  }

  /** Read one record whole, or reject it whole. Only reached through the
   * background's gated sensitive.read path. */
  async function readIndexedDbRecord(params: Record<string, unknown>): Promise<unknown> {
    const database = typeof params.database === 'string' ? params.database : null;
    const storeName = typeof params.store === 'string' ? params.store : null;
    const maxBytes = typeof params.maxBytes === 'number' ? params.maxBytes : 262_144;
    if (database === null || storeName === null || !Object.hasOwn(params, 'key'))
      throw { code: 'INVALID_REQUEST', message: 'database, store, and key are required.' };
    const notFound = (reason: string, message: string) => ({
      code: 'SENSITIVE_TARGET_NOT_FOUND',
      message,
      details: { source: 'indexeddb', reason },
    });
    const key = toIndexedDbKey(params.key);
    let listed: Awaited<ReturnType<IDBFactory['databases']>> | typeof IDB_TIMEOUT;
    try {
      const pending = listIndexedDbDatabases(IDB_OPEN_TIMEOUT_MS);
      if (!pending) throw new Error('unavailable');
      listed = await pending;
    } catch {
      throw notFound('indexeddb_unavailable', 'This document cannot use IndexedDB.');
    }
    if (listed === IDB_TIMEOUT)
      throw {
        code: 'TIMEOUT',
        message: 'IndexedDB did not list its databases in time.',
        details: { source: 'indexeddb', reason: 'indexeddb_timeout' },
      };
    // Never open a name the origin does not already have: open() creates it.
    if (!listed.some((entry) => entry?.name === database))
      throw notFound('database_not_found', 'No IndexedDB database with that name exists here.');
    const opened = await openExistingDatabase(database, IDB_READ_TIMEOUT_MS);
    if ('error' in opened) {
      if (opened.error === 'open_timeout')
        throw {
          code: 'TIMEOUT',
          message:
            'The IndexedDB database did not open in time; another connection may be upgrading it.',
          details: { source: 'indexeddb', reason: 'open_timeout' },
        };
      throw notFound(
        opened.error === 'database_missing' ? 'database_not_found' : 'database_unavailable',
        'The IndexedDB database could not be opened.'
      );
    }
    const db = opened.db;
    let record: unknown;
    try {
      if (!db.objectStoreNames.contains(storeName))
        throw notFound('store_not_found', 'No object store with that name exists in the database.');
      const transaction = db.transaction(storeName, 'readonly');
      let cursorRequest: IDBRequest<IDBCursorWithValue | null>;
      try {
        cursorRequest = transaction.objectStore(storeName).openCursor(key);
      } catch {
        throw {
          code: 'INVALID_REQUEST',
          message: 'The key is not a valid IndexedDB key.',
          details: { source: 'indexeddb', reason: 'unsupported_key_type' },
        };
      }
      const cursor = await idbWithin(idbRequest(cursorRequest), IDB_READ_TIMEOUT_MS);
      if (cursor === IDB_TIMEOUT) {
        try {
          transaction.abort();
        } catch {
          // Already finished.
        }
        throw {
          code: 'TIMEOUT',
          message: 'The IndexedDB record was not read in time.',
          details: { source: 'indexeddb', reason: 'read_timeout' },
        };
      }
      if (!cursor) throw notFound('key_not_found', 'No record with that key exists in the store.');
      record = cursor.value;
    } finally {
      db.close();
    }
    const tooLarge = (bytes: number | null) => ({
      code: 'RESULT_TOO_LARGE',
      message: 'The IndexedDB record is too large to return atomically.',
      details: {
        source: 'indexeddb',
        ...(bytes === null ? {} : { bytes }),
        maxBytes,
        guidance: 'Partial records are never returned.',
      },
    });
    const copy = describeForJson(record);
    if (!copy) throw tooLarge(null);
    const bytes = new TextEncoder().encode(JSON.stringify(copy.json)).byteLength;
    if (bytes > maxBytes) throw tooLarge(bytes);
    return {
      source: 'indexeddb',
      database,
      store: storeName,
      value: copy.json,
      described: copy.described,
      bytes,
      exact: true,
    };
  }

  /** Return the viewport rect for an element reference. */
  function getElementRect(elementRef: string): {
    elementRef: string;
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
  } {
    const el = getRequiredElement(elementRef);
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      throw new Error(
        `Element has no visible area (${rect.width}\u00d7${rect.height}). ` +
          'It may be hidden, collapsed, or not yet rendered.'
      );
    }
    const position = window.getComputedStyle(el).position;
    if (position === 'fixed' || position === 'sticky') {
      throw new Error(`Complete capture is unsupported for a ${position} element.`);
    }
    if (
      window !== window.top &&
      (rect.left < 0 ||
        rect.top < 0 ||
        rect.right > window.innerWidth ||
        rect.bottom > window.innerHeight)
    ) {
      throw new Error(
        'Complete capture is unsupported outside the iframe viewport. Use input.scroll_into_view first.'
      );
    }
    const x = rect.x + window.scrollX;
    const y = rect.y + window.scrollY;
    if (x < 0 || y < 0) {
      throw new Error('Complete capture is unsupported for an element outside page bounds.');
    }
    return {
      elementRef,
      x,
      y,
      width: rect.width,
      height: rect.height,
      scale: window.devicePixelRatio || 1,
    };
  }

  /** Return the full document dimensions for a full-page screenshot.
Chrome enforces a 16384px maximum on CDP captureScreenshot clip dimensions. */
  function getFullPageDimensions(): {
    scrollWidth: number;
    scrollHeight: number;
    devicePixelRatio: number;
  } {
    const el = document.scrollingElement || document.documentElement;
    return {
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  }
})();
