import {
  BridgeError,
  ERROR_CODES,
  MAX_VISUAL_BASELINE_PIXELS,
} from '../../../protocol/src/index.js';
import type { VisualCaptureFrame, VisualRect } from '../../../protocol/src/types.js';
import {
  handleScreenshot,
  type ScreenshotDeps,
  type ResolvedTabTarget,
} from './background-screenshots.js';

/** Notify native storage on cleanup/navigation without transmitting any page data. */
export function invalidateVisualBaselines(port: chrome.runtime.Port | null, tabId: number): void {
  try {
    const message: import('../../../protocol/src/types.js').VisualBaselineInvalidationMessage = {
      type: 'host.visual_baseline_invalidated',
      tabId,
    };
    port?.postMessage(message);
  } catch {
    // Transport disconnect independently clears native retained pixels.
  }
}

/** Visual capture is opt-in. Native Go owns handles, retention, comparison and evidence encoding. */
export async function captureVisualBaseline(
  target: ResolvedTabTarget,
  _method: string,
  params: Record<string, unknown> = {},
  deps: ScreenshotDeps,
  requestId: string
): Promise<VisualCaptureFrame> {
  const sample = async () => {
    const tab = await deps.chrome.tabs.get(target.tabId);
    if (tab.windowId !== target.windowId) {
      throw new BridgeError(
        ERROR_CODES.ACCESS_DENIED,
        'Visual capture tab left the enabled window.'
      );
    }
    const results = await deps.chrome.scripting.executeScript({
      target: { tabId: target.tabId },
      func: readVisualScope,
      args: [typeof params.selector === 'string' ? params.selector : null, params.rect ?? null],
    });
    const entry = results[0];
    if (!entry?.documentId || !entry.result || 'error' in entry.result) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        entry?.result && 'error' in entry.result
          ? (entry.result.error ?? 'Visual scope is unavailable.')
          : 'Visual scope is unavailable.'
      );
    }
    return {
      ...entry.result,
      documentId: entry.documentId,
      tabId: target.tabId,
      windowId: target.windowId,
    };
  };
  const before = await sample();
  const pixels = Math.ceil(before.rect.width * before.rect.height);
  if (pixels > MAX_VISUAL_BASELINE_PIXELS) {
    throw new BridgeError(
      ERROR_CODES.RESULT_TOO_LARGE,
      'Visual scope exceeds four million pixels. Choose a smaller component.'
    );
  }
  // Explicit scale=1 gives one screenshot pixel per viewport CSS pixel, independent of display DPR.
  const image = await handleScreenshot(
    target,
    'screenshot.capture_region',
    {
      ...before.rect,
      format: 'png',
      delivery: 'inline',
      scale: 1,
    },
    deps,
    requestId
  );
  const after = await sample();
  const { contexts: beforeContexts, ...beforeScope } = before;
  const { contexts, ...afterScope } = after;
  if (JSON.stringify(beforeScope) !== JSON.stringify(afterScope) || image.delivery !== 'inline') {
    throw new BridgeError(
      ERROR_CODES.VISUAL_BASELINE_INVALIDATED,
      'The visual scope changed during capture. Wait for a stable view.'
    );
  }
  return {
    image: image.image,
    capturedAt: image.context?.capturedAt ?? new Date().toISOString(),
    scope: afterScope,
    contexts: [...beforeContexts, ...contexts].slice(0, 128),
  };
}

/** Serialized into the isolated world. No application markers, text, form values or page scripts. */
export function readVisualScope(selector: string | null, requestedRect: unknown) {
  const box = (element: Element): VisualRect => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  let rect: VisualRect;
  let root: Element | null = null;
  if (selector !== null && requestedRect === null) {
    if (!selector.trim() || selector.length > 512)
      return { error: 'selector must contain 1..512 characters.' };
    try {
      const matches = document.querySelectorAll(selector);
      if (matches.length !== 1)
        return { error: 'Visual selector must match exactly one complete component.' };
      root = matches[0];
      rect = box(root);
    } catch {
      return { error: 'Invalid visual selector.' };
    }
  } else if (selector === null && requestedRect && typeof requestedRect === 'object') {
    const candidate = requestedRect as Record<string, unknown>;
    if (
      !['x', 'y', 'width', 'height'].every(
        (key) => typeof candidate[key] === 'number' && Number.isFinite(candidate[key])
      )
    )
      return { error: 'Visual rect requires finite x, y, width and height.' };
    rect = candidate as unknown as VisualRect;
  } else {
    return { error: 'Choose exactly one visual selector or rect.' };
  }
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.x + rect.width > window.innerWidth ||
    rect.y + rect.height > window.innerHeight
  )
    return {
      error:
        'Visual scope must fit completely inside the viewport. Scroll first, then create a baseline.',
    };
  // Integer alignment prevents fractional clipping/resampling from inventing pixel changes.
  const right = Math.min(window.innerWidth, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(window.innerHeight, Math.ceil(rect.y + rect.height));
  rect = {
    x: Math.floor(rect.x),
    y: Math.floor(rect.y),
    width: right - Math.floor(rect.x),
    height: bottom - Math.floor(rect.y),
  };
  const contexts: VisualRect[] = [];
  if (
    root?.matches(
      'figure,fieldset,article,section,[role="group"],[role="img"],button,canvas,svg,table'
    )
  )
    contexts.push(box(root));
  const walker = document.createTreeWalker(root ?? document.documentElement, 1);
  for (let i = 0; i < 512 && contexts.length < 64; i++) {
    const node = walker.nextNode();
    if (!node) break;
    const element = node as Element;
    if (
      !element.matches(
        'figure,fieldset,article,section,[role="group"],[role="img"],button,label,canvas,svg,table'
      )
    )
      continue;
    const context = box(element);
    if (
      context.width > 0 &&
      context.height > 0 &&
      context.x < rect.x + rect.width &&
      context.y < rect.y + rect.height &&
      context.x + context.width > rect.x &&
      context.y + context.height > rect.y
    )
      contexts.push(context);
  }
  return {
    rect,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    devicePixelRatio: window.devicePixelRatio,
    viewportScale: window.visualViewport?.scale ?? 1,
    visualViewportX: window.visualViewport?.offsetLeft ?? 0,
    visualViewportY: window.visualViewport?.offsetTop ?? 0,
    visualViewportWidth: window.visualViewport?.width ?? window.innerWidth,
    visualViewportHeight: window.visualViewport?.height ?? window.innerHeight,
    contexts,
  };
}
