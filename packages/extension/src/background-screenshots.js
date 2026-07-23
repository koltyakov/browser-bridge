// @ts-check

import {
  BridgeError,
  ERROR_CODES,
  MAX_ARTIFACT_BYTES,
  MAX_NATIVE_MESSAGE_BYTES,
  SCREENSHOT_AUTO_INLINE_BYTES,
  SCREENSHOT_MAX_INLINE_BYTES,
} from '../../protocol/src/index.js';

/** @typedef {import('./background-state.js').ResolvedTabTarget} ResolvedTabTarget */

const MAX_SCREENSHOT_DIMENSION = 16_384;
const MAX_SCREENSHOT_SCALED_PIXELS = 250_000_000;

/**
 * @typedef {{
 *   run: (tabId: number, callback: (debugTarget: chrome.debugger.Debuggee) => Promise<any>) => Promise<any>,
 * }} TabDebuggerLike
 */

/**
 * @typedef {{
 *   chrome: typeof globalThis.chrome,
 *   contentScriptTimeoutMs: number,
 *   ensureContentScript: (tabId: number) => Promise<void>,
 *   sendTabMessage: (tabId: number, message: Record<string, unknown>, timeoutMs: number) => Promise<any>,
 *   tabDebugger: TabDebuggerLike,
 *   storeArtifact: (requestId: string, data: string, metadata: { mimeType: string, byteLength: number }) => Promise<import('../../protocol/src/types.js').ArtifactDescriptor>,
 * }} ScreenshotDeps
 */

/**
 * Capture a targeted screenshot for the current target tab by asking the content
 * script for an element rect and then cropping the visible tab image.
 *
 * @param {ResolvedTabTarget} target
 * @param {string} method
 * @param {Record<string, unknown> | undefined} params
 * @param {ScreenshotDeps} deps
 * @param {string} requestId
 * @returns {Promise<import('../../protocol/src/types.js').ScreenshotResult>}
 */
export async function handleScreenshot(target, method, params, deps, requestId) {
  const captureParams = params ?? {};
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
  /** @type {{ x: number, y: number, width: number, height: number, scale: number }} */
  let clip;

  if (method === 'screenshot.capture_element') {
    await deps.ensureContentScript(target.tabId);
    const elementParams = Object.fromEntries(
      ['elementRef', 'selector', 'target']
        .filter((key) => captureParams[key] !== undefined)
        .map((key) => [key, captureParams[key]])
    );
    try {
      clip = await deps.sendTabMessage(
        target.tabId,
        {
          type: 'bridge.execute',
          method,
          params: elementParams,
        },
        deps.contentScriptTimeoutMs
      );
    } catch (err) {
      // Retry once after a brief pause - the page may have been mid-render.
      if (err instanceof Error && /stale/i.test(err.message)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        clip = await deps.sendTabMessage(
          target.tabId,
          {
            type: 'bridge.execute',
            method,
            params: elementParams,
          },
          deps.contentScriptTimeoutMs
        );
      } else if (err instanceof Error && /Complete capture is unsupported/.test(err.message)) {
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
    const dims =
      /** @type {{ scrollWidth: number, scrollHeight: number, devicePixelRatio: number }} */ (
        await deps.sendTabMessage(
          target.tabId,
          { type: 'bridge.execute', method, params: {} },
          deps.contentScriptTimeoutMs
        )
      );
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

  // Use CDP Page.captureScreenshot - works regardless of tab focus,
  // captures renderer output directly with built-in clip support.
  return deps.tabDebugger.run(target.tabId, async (debugTarget) => {
    const dpr = clip.scale || 1;
    let pageX = 0;
    let pageY = 0;
    if (method === 'screenshot.capture_region') {
      const metrics = /** @type {{ cssVisualViewport?: { pageX?: number, pageY?: number } }} */ (
        await deps.chrome.debugger.sendCommand(debugTarget, 'Page.getLayoutMetrics')
      );
      pageX = Number(metrics.cssVisualViewport?.pageX) || 0;
      pageY = Number(metrics.cssVisualViewport?.pageY) || 0;
    }
    const cdpResult = /** @type {{ data?: string }} */ (
      await deps.chrome.debugger.sendCommand(debugTarget, 'Page.captureScreenshot', {
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
      })
    );
    if (!cdpResult?.data) {
      throw new Error('CDP Page.captureScreenshot returned empty data.');
    }
    const byteLength = getBase64ByteLength(cdpResult.data);
    const capturedDimensions = getImageDimensions(cdpResult.data, format);
    const metadata = {
      rect: clip,
      format,
      mimeType: /** @type {`image/${import('../../protocol/src/types.js').ScreenshotFormat}`} */ (
        `image/${format}`
      ),
      byteLength,
      dimensions: capturedDimensions ?? {
        width: Math.ceil(clip.width * dpr),
        height: Math.ceil(clip.height * dpr),
      },
      complete: true,
      clipped: false,
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
      const artifact = await deps.storeArtifact(requestId, cdpResult.data, {
        mimeType: metadata.mimeType,
        byteLength,
      });
      return { ...metadata, delivery: 'artifact', artifact };
    }
    return {
      ...metadata,
      delivery: 'inline',
      image: `data:${metadata.mimeType};base64,${cdpResult.data}`,
    };
  });
}

/** @param {string} data */
function getBase64ByteLength(data) {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * Read dimensions from a bounded image prefix so metadata reflects the encoder
 * output without decoding the full screenshot a second time.
 *
 * @param {string} data
 * @param {'png' | 'jpeg' | 'webp'} format
 */
function getImageDimensions(data, format) {
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

/**
 * @param {string} method
 * @param {{ x: number, y: number, width: number, height: number, scale: number }} clip
 * @returns {void}
 */
function assertScreenshotClipWithinLimits(method, clip) {
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
