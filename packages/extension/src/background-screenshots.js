// @ts-check

/** @typedef {import('./background-state.js').ResolvedTabTarget} ResolvedTabTarget */

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
 * @returns {Promise<{ rect: unknown, image: string }>}
 */
export async function handleScreenshot(target, method, params, deps) {
  const captureParams = params ?? {};
  /** @type {{ x: number, y: number, width: number, height: number, scale: number }} */
  let clip;

  if (method === 'screenshot.capture_element') {
    await deps.ensureContentScript(target.tabId);
    try {
      clip = await deps.sendTabMessage(
        target.tabId,
        {
          type: 'bridge.execute',
          method,
          params: captureParams,
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
            params: captureParams,
          },
          deps.contentScriptTimeoutMs
        );
      } else {
        throw err;
      }
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
          { type: 'bridge.execute', method, params: captureParams },
          deps.contentScriptTimeoutMs
        )
      );
    clip = {
      x: 0,
      y: 0,
      width: Math.min(Math.max(1, Number(dims.scrollWidth) || 1), 16384),
      height: Math.min(Math.max(1, Number(dims.scrollHeight) || 1), 16384),
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

  if (clip.width < 1 || clip.height < 1) {
    throw new Error(
      `Capture target has no visible area (${clip.width}\u00d7${clip.height}px). ` +
        'It may be hidden, collapsed, or not yet rendered.'
    );
  }

  // Use CDP Page.captureScreenshot - works regardless of tab focus,
  // captures renderer output directly with built-in clip support.
  return deps.tabDebugger.run(target.tabId, async (debugTarget) => {
    const dpr = clip.scale || 1;
    const cdpResult = /** @type {{ data?: string }} */ (
      await deps.chrome.debugger.sendCommand(debugTarget, 'Page.captureScreenshot', {
        format: 'png',
        clip: {
          x: Math.max(0, clip.x),
          y: Math.max(0, clip.y),
          width: clip.width,
          height: clip.height,
          scale: dpr,
        },
        captureBeyondViewport: method === 'screenshot.capture_full_page',
      })
    );
    if (!cdpResult?.data) {
      throw new Error('CDP Page.captureScreenshot returned empty data.');
    }
    return {
      rect: clip,
      image: `data:image/png;base64,${cdpResult.data}`,
    };
  });
}
