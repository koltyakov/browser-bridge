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
    probeTarget: (params: Record<string, unknown>) => { found: boolean };
    getAttributes: (ref: string, attrs: string[]) => unknown;
    getBoxModel: (ref: string) => unknown;
    getComputedStyles: (ref: string, properties?: string[]) => unknown;
    getHtml: (params: Record<string, unknown>) => unknown;
    getMatchedRules: (ref: string) => unknown;
    getText: (ref: string, budget?: number) => unknown;
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

  const { truncateText } = contentHelpers as {
    truncateText: (
      value: string,
      budget: number
    ) => { value: string; truncated: boolean; omitted: number };
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

  runtimeOnMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'bridge.ping') {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type !== 'bridge.execute') {
      return false;
    }

    try {
      const result = handleCommand(message.method, message.params);
      Promise.resolve(result)
        .then(sendResponse)
        .catch((err) => {
          sendResponse({
            error: serializeContentError(err),
          });
        });
    } catch (error) {
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
        return getStorageData(params);
      case 'sensitive.read':
        return getSensitiveStorageValue(params);
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
        return domQueryModule.getText(resolveElementRefFromParams(params), params.textBudget);
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
      const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
      if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
        return {
          code: candidate.code,
          message: candidate.message,
          details: candidate.details ?? null,
        };
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
        const sample = document.querySelectorAll('[class]');
        const twPattern =
          /\b(?:flex|grid|bg-|text-|p[xytblr]?-|m[xytblr]?-|w-|h-|rounded|shadow|border)-/;
        for (let i = 0; i < Math.min(sample.length, 30); i++) {
          const cls = sample[i].className;
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

  /** Extract the full visible text content of the page. */
  function getFullPageText(params: Record<string, unknown>): {
    value: string;
    truncated: boolean;
    omitted: number;
    length: number;
  } {
    const budget = Number(params.textBudget) || 8000;
    const body = document.body;
    if (!body) {
      return { value: '', truncated: false, omitted: 0, length: 0 };
    }
    const raw = (body.innerText || body.textContent || '').trim();
    const result = truncateText(raw, budget);
    return {
      value: result.value,
      truncated: result.truncated,
      omitted: result.omitted,
      length: raw.length,
    };
  }

  /** Read localStorage or sessionStorage entries. */
  function getStorageData(params: Record<string, unknown>): {
    type: string;
    entries: Array<{ key: string; present: boolean }>;
    count: number;
    total: number;
    truncated: boolean;
  } {
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
    const source = params.source === 'session_storage' ? 'session_storage' : 'local_storage';
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

  /** Return the viewport rect for an element reference. */
  function getElementRect(elementRef: string): {
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
    const x = rect.x + window.scrollX;
    const y = rect.y + window.scrollY;
    if (x < 0 || y < 0) {
      throw new Error('Complete capture is unsupported for an element outside page bounds.');
    }
    return {
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
