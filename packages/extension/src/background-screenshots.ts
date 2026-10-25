import {
  BridgeError,
  ERROR_CODES,
  MAX_ARTIFACT_BYTES,
  MAX_NATIVE_MESSAGE_BYTES,
  SCREENSHOT_AUTO_INLINE_BYTES,
  SCREENSHOT_MAX_INLINE_BYTES,
} from '../../../protocol/src/index.js';
import { resolveContentFrame } from './background-tab-bound.js';

export type ResolvedTabTarget = import('./background-state.js').ResolvedTabTarget;

const MAX_SCREENSHOT_DIMENSION = 16_384;
const MAX_SCREENSHOT_SCALED_PIXELS = 250_000_000;

export type TabDebuggerLike = {
  run: <T>(
    tabId: number,
    callback: (debugTarget: chrome.debugger.Debuggee) => Promise<T>,
    options?: import('./debugger-coordinator.js').DebuggerRunOptions
  ) => Promise<T>;
};

export type ScreenshotDeps = {
  chrome: typeof globalThis.chrome;
  contentScriptTimeoutMs: number;
  ensureContentScript: (tabId: number) => Promise<void>;
  sendTabMessage: (
    tabId: number,
    message: Record<string, unknown>,
    timeoutMs: number
  ) => Promise<unknown>;
  frames?: import('./background-tab-bound.js').TabBoundRequestDependencies['frames'];
  tabDebugger: TabDebuggerLike;
  storeArtifact: (
    requestId: string,
    data: string,
    metadata: { mimeType: string; byteLength: number }
  ) => Promise<import('../../../protocol/src/types.js').ArtifactDescriptor<'screenshot'>>;
};

/** Capture a targeted screenshot for the current target tab by asking the content
script for an element rect and then cropping the visible tab image. */
export async function handleScreenshot(
  target: ResolvedTabTarget,
  method: string,
  params: Record<string, unknown> | undefined,
  deps: ScreenshotDeps,
  requestId: string
): Promise<import('../../../protocol/src/types.js').ScreenshotResult> {
  const startedAt = new Date().toISOString();
  const captureParams = params ?? {};
  let frameId = 0;
  let elementRef: string | null = null;

  const readGeometry = async (
    contentParams: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const message = { type: 'bridge.execute', method, params: contentParams };
    const response =
      frameId !== 0 && deps.frames
        ? await deps.frames.sendFrameMessage(
            target.tabId,
            frameId,
            message,
            deps.contentScriptTimeoutMs
          )
        : await deps.sendTabMessage(target.tabId, message, deps.contentScriptTimeoutMs);
    const result =
      response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
    if (result.error) {
      const error = result.error;
      if (typeof error === 'object') {
        const structured = error as Record<string, unknown>;
        throw new BridgeError(
          typeof structured.code === 'string'
            ? (structured.code as import('../../../protocol/src/types.js').ErrorCode)
            : ERROR_CODES.INTERNAL_ERROR,
          typeof structured.message === 'string'
            ? structured.message
            : 'Screenshot geometry failed.',
          structured.details ?? null
        );
      }
      throw new Error(String(error));
    }
    return result;
  };
  const format =
    captureParams.format === 'jpeg' || captureParams.format === 'webp'
      ? captureParams.format
      : 'png';
  const quality =
    format !== 'png' && typeof captureParams.quality === 'number'
      ? Math.min(100, Math.max(0, Math.trunc(captureParams.quality)))
      : null;
  const requestedScale =
    typeof captureParams.scale === 'number' && Number.isFinite(captureParams.scale)
      ? Math.min(4, Math.max(0.1, captureParams.scale))
      : null;

  let clip: { x: number; y: number; width: number; height: number; scale: number };

  if (method === 'screenshot.capture_element') {
    await deps.ensureContentScript(target.tabId);
    const elementParams = Object.fromEntries(
      ['elementRef', 'selector', 'target']
        .filter((key) => captureParams[key] !== undefined)
        .map((key) => [key, captureParams[key]])
    );
    frameId = await resolveContentFrame(method, elementParams, target.tabId, deps);
    try {
      const geometry = await readGeometry(elementParams);
      clip = geometry as typeof clip;
      elementRef = typeof geometry.elementRef === 'string' ? geometry.elementRef : null;
    } catch (err) {
      if (err instanceof Error && /Complete capture is unsupported/.test(err.message)) {
        throw new BridgeError(ERROR_CODES.RESULT_TRUNCATED, err.message, {
          method,
          elementRef: captureParams.elementRef,
          complete: false,
          clipped: false,
        });
      } else {
        throw err;
      }
    }
    if (Number(clip.x) < 0 || Number(clip.y) < 0) {
      throw new BridgeError(
        ERROR_CODES.RESULT_TRUNCATED,
        'Complete capture is unsupported for an element outside page bounds.',
        { method, elementRef: captureParams.elementRef, complete: false, clipped: false }
      );
    }
    // Defensively coerce content-script values - NaN / undefined / negative
    // would slip past the < 1 guard and reach CDP as invalid values.
    clip = {
      x: Math.max(0, Number(clip.x) || 0),
      y: Math.max(0, Number(clip.y) || 0),
      width: Math.max(0, Number(clip.width) || 0),
      height: Math.max(0, Number(clip.height) || 0),
      scale: Number(clip.scale) || 1,
    };
  } else if (method === 'screenshot.capture_full_page') {
    await deps.ensureContentScript(target.tabId);
    const dims = (await readGeometry({})) as {
      scrollWidth: number;
      scrollHeight: number;
      devicePixelRatio: number;
    };
    clip = {
      x: 0,
      y: 0,
      width: Math.max(1, Number(dims.scrollWidth) || 1),
      height: Math.max(1, Number(dims.scrollHeight) || 1),
      scale: Number(dims.devicePixelRatio) || 1,
    };
  } else {
    // capture_region: params already carry viewport coordinates
    const scale = Number(captureParams.scale) || 1;
    clip = {
      x: Number(captureParams.x) || 0,
      y: Number(captureParams.y) || 0,
      width: Math.max(1, Number(captureParams.width) || 1),
      height: Math.max(1, Number(captureParams.height) || 1),
      scale,
    };
  }

  if (requestedScale !== null) clip.scale = requestedScale;

  if (clip.width < 1 || clip.height < 1) {
    throw new Error(
      `Capture target has no visible area (${clip.width}\u00d7${clip.height}px). ` +
        'It may be hidden, collapsed, or not yet rendered.'
    );
  }

  assertScreenshotClipWithinLimits(method, clip);
  const delivery = captureParams.delivery ?? 'inline';
  const estimatedTransportBytes = Math.ceil(
    clip.width * clip.height * clip.scale * clip.scale * (4 / 3)
  );
  const preflightRequiresArtifact =
    delivery === 'auto' && estimatedTransportBytes > MAX_NATIVE_MESSAGE_BYTES;
  const dpr = clip.scale || 1;

  // Use CDP Page.captureScreenshot - works regardless of tab focus,
  // captures renderer output directly with built-in clip support.
  let pageClip = { ...clip };
  const [tabState, windowState, documentState] = await Promise.all([
    deps.chrome.tabs?.get?.(target.tabId).catch(() => null) ?? null,
    deps.chrome.windows?.get?.(target.windowId).catch(() => null) ?? null,
    deps.chrome.scripting
      ?.executeScript?.({ target: { tabId: target.tabId }, func: readScreenshotDocumentState })
      .then((results) => results[0]?.result ?? null)
      .catch(() => null) ?? null,
  ]);
  const data = await deps.tabDebugger.run(
    target.tabId,
    async (debugTarget) => {
      let pageX = 0;
      let pageY = 0;
      if (frameId !== 0) {
        if (!elementRef)
          throw new BridgeError(
            ERROR_CODES.ELEMENT_STALE,
            'Screenshot target ref is unavailable.',
            { frameId }
          );
        const bounds = await readChildElementBounds(deps.chrome, debugTarget, elementRef);
        clip = { ...bounds, scale: clip.scale };
        assertScreenshotClipWithinLimits(method, clip);
      }
      if (method === 'screenshot.capture_region') {
        const metrics = (await deps.chrome.debugger.sendCommand(
          debugTarget,
          'Page.getLayoutMetrics'
        )) as { cssVisualViewport?: { pageX?: number; pageY?: number } };
        pageX = Number(metrics.cssVisualViewport?.pageX) || 0;
        pageY = Number(metrics.cssVisualViewport?.pageY) || 0;
      }
      const cdpResult = (await deps.chrome.debugger.sendCommand(
        debugTarget,
        'Page.captureScreenshot',
        {
          format,
          ...(quality === null ? {} : { quality }),
          clip: {
            x: Math.max(0, clip.x + pageX),
            y: Math.max(0, clip.y + pageY),
            width: clip.width,
            height: clip.height,
            scale: dpr,
          },
          captureBeyondViewport: true,
        }
      )) as { data?: string };
      pageClip = { ...clip, x: Math.max(0, clip.x + pageX), y: Math.max(0, clip.y + pageY) };
      if (!cdpResult?.data) {
        throw new Error('CDP Page.captureScreenshot returned empty data.');
      }
      return cdpResult.data;
    },
    { retryDetached: true, releaseAfterRun: true }
  );
  const byteLength = getBase64ByteLength(data);
  const capturedDimensions = getImageDimensions(data, format);

  const metadata: import('../../../protocol/src/types.js').ScreenshotMetadata = {
    rect: clip,
    format,
    mimeType:
      `image/${format}` as `image/${import('../../../protocol/src/types.js').ScreenshotFormat}`,
    byteLength,
    dimensions: capturedDimensions ?? {
      width: Math.ceil(clip.width * dpr),
      height: Math.ceil(clip.height * dpr),
    },
    complete: true,
    clipped: false,
    context: {
      startedAt,
      capturedAt: new Date().toISOString(),
      tabId: target.tabId,
      tabActive: tabState?.active ?? null,
      windowFocused: windowState?.focused ?? null,
      visibility:
        documentState?.visibility === 'visible' || documentState?.visibility === 'hidden'
          ? documentState.visibility
          : null,
      documentFocused: typeof documentState?.focused === 'boolean' ? documentState.focused : null,
      rectSpace: method === 'screenshot.capture_region' ? 'viewport-css' : 'document-css',
      pageClip,
      source: 'cdp-renderer',
    },
  };
  if (delivery === 'inline' && byteLength > SCREENSHOT_MAX_INLINE_BYTES) {
    throw new BridgeError(
      ERROR_CODES.RESULT_TOO_LARGE,
      `Screenshot is too large for inline delivery (${byteLength} bytes).`,
      {
        byteLength,
        maxInlineBytes: SCREENSHOT_MAX_INLINE_BYTES,
        guidance: 'Use delivery=artifact.',
      }
    );
  }
  if (
    delivery === 'artifact' ||
    (delivery === 'auto' &&
      (preflightRequiresArtifact || byteLength > SCREENSHOT_AUTO_INLINE_BYTES))
  ) {
    if (byteLength > MAX_ARTIFACT_BYTES) {
      throw new BridgeError(
        ERROR_CODES.RESULT_TOO_LARGE,
        `Screenshot is too large for artifact delivery (${byteLength} bytes).`,
        {
          byteLength,
          maxArtifactBytes: MAX_ARTIFACT_BYTES,
          guidance: 'Use a smaller region, lower scale, or lossy format and quality.',
        }
      );
    }
    const artifact = await deps.storeArtifact(requestId, data, {
      mimeType: metadata.mimeType,
      byteLength,
    });
    return { ...metadata, delivery: 'artifact', artifact };
  }
  return {
    ...metadata,
    delivery: 'inline',
    image: `data:${metadata.mimeType};base64,${data}`,
  };
}

/** Resolve the exact extension-owned node through CDP, whose box coordinates
 * are relative to the top-level document, not the child viewport. Never use
 * a same-named registry supplied by the page's MAIN world. Separate-process
 * iframe sessions are attached without pausing and released after the read. */
export async function readChildElementBounds(
  chromeObj: typeof globalThis.chrome,
  debugTarget: chrome.debugger.DebuggerSession,
  elementRef: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  type Session = { target: chrome.debugger.DebuggerSession; parent?: Session; frameId?: string };
  const root: Session = { target: debugTarget };
  const sessions = new Map<string, Session>();
  const contexts: Array<{ id: number; session: Session }> = [];
  const enabled: Session[] = [];
  const attached: Session[] = [];
  const extensionId = chromeObj.runtime.id;
  const onEvent = (source: chrome.debugger.DebuggerSession, method: string, params?: object) => {
    if (source.tabId !== debugTarget.tabId) return;
    const session =
      source.sessionId === debugTarget.sessionId ? root : sessions.get(source.sessionId ?? '');
    if (!session) return;
    if (method === 'Target.attachedToTarget') {
      const entry = params as {
        sessionId?: string;
        targetInfo?: { type?: string; targetId?: string };
      };
      if (
        entry.sessionId &&
        entry.targetInfo?.type === 'iframe' &&
        !sessions.has(entry.sessionId)
      ) {
        sessions.set(entry.sessionId, {
          target: { ...debugTarget, sessionId: entry.sessionId },
          parent: session,
          frameId: entry.targetInfo.targetId,
        });
      }
      return;
    }
    if (method !== 'Runtime.executionContextCreated') return;
    const context = (
      params as { context?: { id: number; origin?: string; auxData?: { isDefault?: boolean } } }
    )?.context;
    if (context?.auxData?.isDefault === false) contexts.push({ id: context.id, session });
  };
  const send = (session: Session, method: string, params: Record<string, unknown>) =>
    chromeObj.debugger.sendCommand(session.target, method, params);
  const attach = async (session: Session) => {
    await send(session, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
    });
    attached.push(session);
  };
  const enable = async (session: Session) => {
    await send(session, 'Runtime.enable', {});
    enabled.push(session);
  };
  chromeObj.debugger.onEvent.addListener(onEvent);
  try {
    await enable(root);
    const tag = /^el_([0-9a-z]{4})_/.exec(elementRef)?.[1];
    if (!tag) throw new BridgeError(ERROR_CODES.ELEMENT_STALE, 'Invalid screenshot element ref.');
    let inspected = 0;
    for (;;) {
      while (inspected < contexts.length) {
        const { id: contextId, session } = contexts[inspected++];
        const probe = (await send(session, 'Runtime.evaluate', {
          contextId,
          expression: `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)} && globalThis.__BBX_CONTENT_REGISTRY__?.refDocumentTag === ${JSON.stringify(tag)}`,
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        if (probe.result?.value !== true) continue;
        const resolved = (await send(session, 'Runtime.evaluate', {
          contextId,
          expression: `globalThis.__BBX_CONTENT_REGISTRY__.getRequiredElement(${JSON.stringify(elementRef)})`,
          returnByValue: false,
        })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
        const objectId = resolved.result?.objectId;
        if (!objectId || resolved.exceptionDetails)
          throw new BridgeError(
            ERROR_CODES.ELEMENT_STALE,
            'Screenshot target is no longer attached.'
          );
        try {
          const box = (await send(session, 'DOM.getBoxModel', { objectId })) as {
            model?: { border?: number[] };
          };
          const quad = box.model?.border;
          if (!quad || quad.length !== 8 || quad.some((value) => !Number.isFinite(value)))
            throw new BridgeError(
              ERROR_CODES.ELEMENT_NOT_ACTIONABLE,
              'Screenshot target has no rendered box.'
            );
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          const ys = [quad[1], quad[3], quad[5], quad[7]];
          let bounds = {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
          };
          let current = session;
          while (current.parent && current.frameId) {
            const owner = (await send(current.parent, 'DOM.getFrameOwner', {
              frameId: current.frameId,
            })) as { backendNodeId?: number };
            const [ownerBox, metrics] = await Promise.all([
              send(current.parent, 'DOM.getBoxModel', {
                backendNodeId: owner.backendNodeId,
              }) as Promise<{
                model?: { content?: number[]; border?: number[]; width?: number; height?: number };
              }>,
              send(current, 'Page.getLayoutMetrics', {}) as Promise<{
                cssLayoutViewport?: {
                  pageX: number;
                  pageY: number;
                  clientWidth: number;
                  clientHeight: number;
                };
              }>,
            ]);
            const content = ownerBox.model?.content;
            const border = ownerBox.model?.border;
            const width = Number(ownerBox.model?.width);
            const height = Number(ownerBox.model?.height);
            const viewport = metrics.cssLayoutViewport;
            if (
              !content ||
              content.length !== 8 ||
              content.some((value) => !Number.isFinite(value)) ||
              !border ||
              border.length !== 8 ||
              border.some((value) => !Number.isFinite(value)) ||
              !(width > 0) ||
              !(height > 0) ||
              !viewport ||
              viewport.clientWidth <= 0 ||
              viewport.clientHeight <= 0 ||
              content[1] !== content[3] ||
              content[0] !== content[6] ||
              content[2] !== content[4] ||
              content[5] !== content[7] ||
              content[2] <= content[0] ||
              content[5] <= content[1]
            )
              throw new BridgeError(
                ERROR_CODES.RESULT_TRUNCATED,
                'Complete iframe capture is unsupported for transformed or unavailable frame geometry.'
              );
            // Layout viewport sizes can differ from the embedded viewport due
            // to scrollbars. Derive CSS transform scale from the owner's own
            // border box instead, preserving exact untransformed coordinates.
            const scaleX = (border[2] - border[0]) / width;
            const scaleY = (border[5] - border[1]) / height;
            bounds = {
              x: content[0] + (bounds.x - viewport.pageX) * scaleX,
              y: content[1] + (bounds.y - viewport.pageY) * scaleY,
              width: bounds.width * scaleX,
              height: bounds.height * scaleY,
            };
            current = current.parent;
          }
          const { x, y } = bounds;
          if (x < 0 || y < 0)
            throw new BridgeError(
              ERROR_CODES.RESULT_TRUNCATED,
              'Complete capture is unsupported outside page bounds.'
            );
          if (bounds.width < 1 || bounds.height < 1)
            throw new BridgeError(
              ERROR_CODES.ELEMENT_NOT_ACTIONABLE,
              'Screenshot target has no rendered area.'
            );
          return bounds;
        } finally {
          await send(session, 'Runtime.releaseObject', { objectId }).catch(() => {});
        }
      }
      if (!attached.length) await attach(root);
      const next = [...sessions.values()].find((session) => !enabled.includes(session));
      if (!next || enabled.length >= 12) break;
      await enable(next);
      await attach(next);
    }
    throw new BridgeError(
      ERROR_CODES.INPUT_UNSUPPORTED,
      'The iframe screenshot context is not reachable from this debugger target. Capture the outer iframe element instead.'
    );
  } finally {
    chromeObj.debugger.onEvent.removeListener(onEvent);
    for (const session of enabled.reverse())
      await send(session, 'Runtime.disable', {}).catch(() => {});
    for (const session of attached.reverse())
      await send(session, 'Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      }).catch(() => {});
  }
}

/** Sample document visibility in the isolated world without reading page content. */
export function readScreenshotDocumentState() {
  return { visibility: document.visibilityState, focused: document.hasFocus() };
}

function getBase64ByteLength(data: string) {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** Read dimensions from a bounded image prefix so metadata reflects the encoder
output without decoding the full screenshot a second time. */
function getImageDimensions(data: string, format: 'png' | 'jpeg' | 'webp') {
  try {
    const prefix = data.slice(0, Math.min(data.length, 87_380));
    const binary = atob(prefix.slice(0, prefix.length - (prefix.length % 4)));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (
      format === 'png' &&
      bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (format === 'jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
      for (let offset = 2; offset + 8 < bytes.length;) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        if (length < 2) break;
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return {
            width: (bytes[offset + 7] << 8) | bytes[offset + 8],
            height: (bytes[offset + 5] << 8) | bytes[offset + 6],
          };
        }
        offset += length + 2;
      }
    }
    if (
      format === 'webp' &&
      bytes.length >= 30 &&
      String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
    ) {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === 'VP8X') {
        return {
          width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
          height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
        };
      }
      if (chunk === 'VP8L' && bytes[20] === 0x2f) {
        return {
          width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
          height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
        };
      }
      if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return {
          width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
          height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
        };
      }
    }
  } catch {}
  return null;
}

function assertScreenshotClipWithinLimits(
  method: string,
  clip: { x: number; y: number; width: number; height: number; scale: number }
): void {
  const scale = Math.max(1, clip.scale || 1);
  const scaledPixels = Math.ceil(clip.width * clip.height * scale * scale);
  if (
    clip.width <= MAX_SCREENSHOT_DIMENSION &&
    clip.height <= MAX_SCREENSHOT_DIMENSION &&
    scaledPixels <= MAX_SCREENSHOT_SCALED_PIXELS
  ) {
    return;
  }

  throw new BridgeError(
    ERROR_CODES.RESULT_TRUNCATED,
    `Screenshot capture is too large (${clip.width}\u00d7${clip.height} at ${scale}x).`,
    {
      method,
      width: clip.width,
      height: clip.height,
      scale,
      scaledPixels,
      maxDimension: MAX_SCREENSHOT_DIMENSION,
      maxScaledPixels: MAX_SCREENSHOT_SCALED_PIXELS,
    }
  );
}
