// @ts-check

(() => {
  const contentScriptGlobal =
    /** @type {typeof globalThis & { __chromeCodexBridgeContentScriptLoaded?: boolean }} */ (
      globalThis
    );
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

  const contentHelpers =
    /** @type {typeof globalThis & { __BBX_CONTENT_HELPERS__?: Record<string, unknown> }} */ (
      globalThis
    ).__BBX_CONTENT_HELPERS__;
  if (!contentHelpers) {
    throw new Error('Browser Bridge content-script helpers must load before content-script.js.');
  }

  const registry =
    /** @type {typeof globalThis & { __BBX_CONTENT_REGISTRY__?: Record<string, unknown> }} */ (
      globalThis
    ).__BBX_CONTENT_REGISTRY__;
  if (!registry) {
    throw new Error('Browser Bridge content-element-registry must load before content-script.js.');
  }

  const domBaseline =
    /** @type {typeof globalThis & { __bbxContentDomBaseline?: { capture: (params: Record<string, unknown>) => unknown } }} */ (
      globalThis
    ).__bbxContentDomBaseline;
  if (!domBaseline) {
    throw new Error('Browser Bridge content-dom-baseline must load before content-script.js.');
  }
  const baselineModule = domBaseline;

  /**
   * @typedef {{
   *   describeElement: (ref: string) => any,
   *   domQuery: (params: Record<string, any>) => any,
   *   findByRole: (params: Record<string, any>) => any,
   *   findByText: (params: Record<string, any>) => any,
   *   getAttributes: (ref: string, attrs: string[]) => any,
   *   getBoxModel: (ref: string) => any,
   *   getComputedStyles: (ref: string, properties?: string[]) => any,
   *   getHtml: (params: Record<string, any>) => any,
   *   getMatchedRules: (ref: string) => any,
   *   getText: (ref: string, budget?: number) => any,
   *   hitTest: (x: number, y: number) => any,
   *   summarizeNode: (element: Element, attrs: string[], budget: number, bbox: boolean) => any,
   *   waitForDom: (params: Record<string, any>) => any
   * }} DomQueryModule
   */

  /**
   * @typedef {{
   *   clickTarget: (params: Record<string, any>) => any,
   *   dragTarget: (params: Record<string, any>) => any,
   *   fillTarget: (params: Record<string, any>) => any,
   *   focusTarget: (params: Record<string, any>) => any,
   *   hoverTarget: (params: Record<string, any>) => any,
   *   prepareNativeInput: (params: Record<string, unknown>) => unknown,
   *   revalidateNativeInput: (params: Record<string, unknown>) => unknown,
   *   readInputValue: (params: Record<string, unknown>) => unknown,
   *   pressKeyTarget: (params: Record<string, any>) => any,
   *   scrollIntoViewTarget: (params: Record<string, any>) => any,
   *   scrollViewport: (params: Record<string, any>) => any,
   *   selectOptionTarget: (params: Record<string, any>) => any,
   *   setCheckedTarget: (params: Record<string, any>) => any,
   *   typeIntoTarget: (params: Record<string, any>) => any
   * }} InputModule
   */

  /**
   * @typedef {{
   *   applyStylePatch: (params: Record<string, unknown>) => unknown,
   *   applyDomPatch: (params: Record<string, unknown>) => unknown,
   *   commitSessionBaseline: () => { committed: true },
   *   listPatches: () => unknown,
   *   rollbackPatch: (patchId: string) => unknown
   * }} PatchModule
   */

  const domQueryModule = /** @type {DomQueryModule} */ (
    /** @type {typeof globalThis & { __BBX_CONTENT_DOM_QUERY__?: DomQueryModule }} */ (
      globalThis
    ).__BBX_CONTENT_DOM_QUERY__
  );
  const inputModule = /** @type {InputModule} */ (
    /** @type {typeof globalThis & { __BBX_CONTENT_INPUT__?: InputModule }} */ (
      globalThis
    ).__BBX_CONTENT_INPUT__
  );
  const patchModule = /** @type {PatchModule} */ (
    /** @type {typeof globalThis & { __BBX_CONTENT_PATCH__?: PatchModule }} */ (
      globalThis
    ).__BBX_CONTENT_PATCH__
  );

  const { truncateText } =
    /** @type {{ truncateText: (value: string, budget: number) => { value: string, truncated: boolean, omitted: number } }} */ (
      contentHelpers
    );
  const { getRequiredElement, resolveElementRefFromParams } =
    /** @type {{ getRequiredElement: (ref: string) => Element, resolveElementRefFromParams: (params?: Record<string, any>) => string }} */ (
      registry
    );

  /**
   * @typedef {{
   *   elementRef: string,
   *   tag: string,
   *   role: string | null,
   *   name: string | null,
   *   textExcerpt: string,
   *   attrs: Record<string, string | null>,
   *   bbox?: { x: number, y: number, width: number, height: number }
   * }} NodeSummary
   */

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

  /**
   * Dispatch a bridge method within the page context.
   *
   * @param {string} method
   * @param {Record<string, any>} params
   * @returns {unknown}
   */
  function handleCommand(method, params) {
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
      case 'dom.get_html':
        return domQueryModule.getHtml({
          ...params,
          elementRef: resolveElementRefFromParams(params),
        });
      case 'layout.get_box_model':
        return domQueryModule.getBoxModel(resolveElementRefFromParams(params));
      case 'layout.hit_test':
        return domQueryModule.hitTest(params.x, params.y);
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
      case 'input.resolve_native':
        return inputModule.prepareNativeInput(params);
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
        return patchModule.rollbackPatch(params.patchId);
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

  /**
   * Preserve structured input resolution failures while retaining string
   * errors for older content operations.
   *
   * @param {unknown} error
   * @returns {string | { code: string, message: string, details: unknown }}
   */
  function serializeContentError(error) {
    if (error && typeof error === 'object') {
      const candidate = /** @type {{ code?: unknown, message?: unknown, details?: unknown }} */ (
        error
      );
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

  /**
   * Return lightweight page state useful for browser automation decisions.
   *
   * @returns {{
   *   url: string,
   *   origin: string,
   *   title: string,
   *   readyState: DocumentReadyState,
   *   focused: boolean,
   *   viewport: { width: number, height: number, devicePixelRatio: number },
   *   scroll: { x: number, y: number, maxX: number, maxY: number },
   *   activeElement: NodeSummary | null,
   *   selection: { value: string, truncated: boolean, omitted: number },
   *   hints: { tailwind: boolean }
   * }}
   */
  function getPageState() {
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
          ? /** @type {NodeSummary} */ (
              domQueryModule.summarizeNode(
                document.activeElement,
                ['id', 'class', 'name', 'type', 'href', 'role'],
                120,
                true
              ).node
            )
          : null,
      selection: truncateText(selection.trim(), 200),
      hints: detectPageHints(),
    };
  }

  /**
   * Detect CSS frameworks and page characteristics for agent guidance.
   * Lightweight - only checks a few DOM/stylesheet signals.
   *
   * @returns {{ tailwind: boolean }}
   */
  function detectPageHints() {
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

  /**
   * Extract the full visible text content of the page.
   *
   * @param {Record<string, any>} params
   * @returns {{ value: string, truncated: boolean, omitted: number, length: number }}
   */
  function getFullPageText(params) {
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

  /**
   * Read localStorage or sessionStorage entries.
   *
   * @param {Record<string, any>} params
   * @returns {{ type: string, entries: Array<{ key: string, present: boolean }>, count: number, total: number, truncated: boolean }}
   */
  function getStorageData(params) {
    const type = params.type === 'session' ? 'session' : 'local';
    const storage = type === 'session' ? sessionStorage : localStorage;
    const keys = Array.isArray(params.keys)
      ? params.keys.filter((k) => typeof k === 'string')
      : null;
    /** @type {Array<{ key: string, present: boolean }>} */
    const entries = [];
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

  /**
   * Deliberately return one exact Web Storage value or reject it atomically.
   *
   * @param {Record<string, any>} params
   * @returns {{ source: 'local_storage' | 'session_storage', value: string, exact: true }}
   */
  function getSensitiveStorageValue(params) {
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

  /**
   * Return the viewport rect for an element reference.
   *
   * @param {string} elementRef
   * @returns {{ x: number, y: number, width: number, height: number, scale: number }}
   */
  function getElementRect(elementRef) {
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

  /**
   * Return the full document dimensions for a full-page screenshot.
   * Chrome enforces a 16384px maximum on CDP captureScreenshot clip dimensions.
   *
   * @returns {{ scrollWidth: number, scrollHeight: number, devicePixelRatio: number }}
   */
  function getFullPageDimensions() {
    const el = document.scrollingElement || document.documentElement;
    return {
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  }
})();
