export type TabCleanupResource = {
  name: string;
  clear: (tabId: number) => void | Promise<unknown>;
  removed?: (tabId: number) => void | Promise<unknown>;
};

export type TabCleanupControllerDeps = {
  ensureContentScript: (tabId: number) => Promise<void>;
  sendTabMessage: (
    tabId: number,
    message: Record<string, unknown>,
    timeoutMs: number
  ) => Promise<unknown>;
  listFrames?: (tabId: number) => Promise<Array<{ frameId: number }>>;
  clearFrames?: (tabId: number) => void;
  sendFrameMessage?: (
    tabId: number,
    frameId: number,
    message: Record<string, unknown>,
    timeoutMs: number
  ) => Promise<unknown>;
  disableConsoleInterceptor?: (tabId: number, chrome: typeof globalThis.chrome) => Promise<void>;
  disableNetworkInterceptor?: (tabId: number, chrome: typeof globalThis.chrome) => Promise<void>;
  readConsoleBuffer?: (
    tabId: number,
    clear: boolean,
    chrome: typeof globalThis.chrome
  ) => Promise<unknown>;
  readNetworkBuffer?: (
    tabId: number,
    clear: boolean,
    chrome: typeof globalThis.chrome
  ) => Promise<unknown>;
  beginDebuggerCleanup: (tabId: number) => Promise<() => void>;
  commitDebuggerCleanup: (tabId: number) => Promise<void>;
  clearFetchInterception: (tabId: number) => Promise<number>;
  discardFetchInterception: (tabId: number) => void;
  stopCdpNetworkCapture: (tabId: number) => Promise<unknown>;
  discardCdpNetworkCapture: (tabId: number) => Promise<unknown>;
  cancelNavigationWaitsForWindow: (windowId: number) => void;
  isRecoverableInstrumentationError: (error: unknown) => boolean;
  isRestrictedAutomationUrl: (url: string) => boolean;
  resources?: readonly TabCleanupResource[];
};
import { CONTENT_SCRIPT_TIMEOUT_MS, isNumber } from './background-state.js';

/** Isolate tab/window cleanup so the background worker stays focused on request
orchestration instead of patch/buffer teardown details. */
export function createTabCleanupController(
  chrome: typeof globalThis.chrome,
  deps: TabCleanupControllerDeps
): {
  clearTabBridgeState: (tabId: number, shouldContinue?: () => Promise<boolean>) => Promise<void>;
  clearWindowBridgeState: (windowId: number) => Promise<void>;
  clearRemovedTabState: (tabId: number) => Promise<void>;
  rollbackAllPatchesForTab: (tabId: number) => Promise<void>;
} {
  async function clearResources(tabId: number, removed = false): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const resource of deps.resources ?? []) {
      try {
        await (removed ? (resource.removed ?? resource.clear) : resource.clear)(tabId);
      } catch (error) {
        errors.push(
          new Error(`Could not clear ${resource.name} for tab ${tabId}`, { cause: error })
        );
      }
    }
    return errors;
  }

  async function clearDebuggerState(
    tabId: number,
    errors: unknown[],
    removed = false
  ): Promise<void> {
    const endCleanup = await deps.beginDebuggerCleanup(tabId);
    try {
      for (const clear of [
        deps.commitDebuggerCleanup,
        async (id: number) => errors.push(...(await clearResources(id, removed))),
        deps.clearFetchInterception,
        deps.stopCdpNetworkCapture,
        deps.discardCdpNetworkCapture,
      ]) {
        try {
          await clear(tabId);
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      endCleanup();
    }
  }

  async function clearRemovedTabState(tabId: number): Promise<void> {
    const errors: unknown[] = [];
    await clearDebuggerState(tabId, errors, true);
    deps.clearFrames?.(tabId);
    if (errors.length) throw new AggregateError(errors, `Tab ${tabId} cleanup failed`);
  }
  /** Roll back all reversible patches currently tracked in one tab. */
  async function rollbackAllPatchesForTab(
    tabId: number,
    shouldContinue = async () => true
  ): Promise<void> {
    try {
      if (!(await shouldContinue())) return;
      await deps.ensureContentScript(tabId);
      if (!(await shouldContinue())) return;
      const frames = [
        { frameId: 0 },
        ...(deps.listFrames ? await deps.listFrames(tabId) : []).filter(
          (frame) => frame.frameId !== 0
        ),
      ];
      const results = await Promise.allSettled(
        frames.map(async ({ frameId }) => {
          if (!(await shouldContinue())) return;
          const send = (message: Record<string, unknown>) =>
            frameId !== 0 && deps.sendFrameMessage
              ? deps.sendFrameMessage(tabId, frameId, message, CONTENT_SCRIPT_TIMEOUT_MS)
              : deps.sendTabMessage(tabId, message, CONTENT_SCRIPT_TIMEOUT_MS);
          const listed = await send({
            type: 'bridge.execute',
            method: 'patch.list',
            params: {},
          });
          const patches = Array.isArray(listed)
            ? listed
            : listed && typeof listed === 'object' && 'patches' in listed
              ? listed.patches
              : undefined;
          if (!Array.isArray(patches)) {
            return;
          }
          for (const patch of [...patches].reverse()) {
            if (!(await shouldContinue())) return;
            const patchId =
              patch && typeof patch === 'object'
                ? (patch as Record<string, unknown>).patchId
                : null;
            if (typeof patchId !== 'string' || !patchId) {
              continue;
            }
            await send({
              type: 'bridge.execute',
              method: 'patch.rollback',
              params: { patchId },
            });
          }
        })
      );
      const errors = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected' && !deps.isRecoverableInstrumentationError(result.reason)
      );
      if (errors.length === 1) throw errors[0].reason;
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          'Frame patch cleanup failed'
        );
      deps.clearFrames?.(tabId);
    } catch (error) {
      if (!deps.isRecoverableInstrumentationError(error)) {
        throw error;
      }
    }
  }

  /** Clear bridge buffers and roll back active patches for one tab. */
  async function clearTabBridgeState(
    tabId: number,
    shouldContinue = async () => true
  ): Promise<void> {
    if (!(await shouldContinue())) return;

    const instrumentationErrors: unknown[] = [];
    const endCleanup = await deps.beginDebuggerCleanup(tabId);
    try {
      if (!(await shouldContinue())) return;
      // Hard cancellation must precede resources whose release is queued behind
      // a command paused by a JavaScript dialog.
      try {
        await deps.commitDebuggerCleanup(tabId);
      } catch (error) {
        instrumentationErrors.push(error);
      }
      instrumentationErrors.push(...(await clearResources(tabId)));
      const disableConsole =
        deps.disableConsoleInterceptor ??
        (async (id, chromeObj) => {
          await deps.readConsoleBuffer?.(id, true, chromeObj);
        });
      const disableNetwork =
        deps.disableNetworkInterceptor ??
        (async (id, chromeObj) => {
          await deps.readNetworkBuffer?.(id, true, chromeObj);
        });
      for (const disable of [disableConsole, disableNetwork]) {
        try {
          await disable(tabId, chrome);
        } catch (error) {
          if (!deps.isRecoverableInstrumentationError(error)) instrumentationErrors.push(error);
        }
      }
      if (!(await shouldContinue())) {
        if (instrumentationErrors.length > 0) throw instrumentationErrors[0];
        return;
      }
      if (!(await shouldContinue())) return;
      try {
        if (await shouldContinue()) {
          try {
            await deps.clearFetchInterception(tabId);
          } catch (error) {
            instrumentationErrors.push(error);
          }
        } else {
          deps.discardFetchInterception(tabId);
        }
        if (await shouldContinue()) {
          await deps.stopCdpNetworkCapture(tabId).catch(() => {});
        }
      } finally {
        try {
          await deps.discardCdpNetworkCapture(tabId);
        } catch (error) {
          instrumentationErrors.push(error);
        }
      }
      if (!(await shouldContinue())) return;
      try {
        await rollbackAllPatchesForTab(tabId, shouldContinue);
      } catch (error) {
        if (!deps.isRecoverableInstrumentationError(error)) {
          instrumentationErrors.push(error);
        }
      }
      if (instrumentationErrors.length > 0)
        throw new AggregateError(instrumentationErrors, `Tab ${tabId} cleanup failed`);
    } finally {
      endCleanup();
    }
  }

  /** Clear tab-local bridge state for all tabs in one window. */
  async function clearWindowBridgeState(windowId: number): Promise<void> {
    deps.cancelNavigationWaitsForWindow(windowId);
    const tabs = await chrome.tabs.query({ windowId });
    const results = await Promise.allSettled(
      tabs.map((tab) => {
        if (!isNumber(tab.id)) return Promise.resolve();
        const tabId = tab.id;
        return tab.url && !deps.isRestrictedAutomationUrl(tab.url)
          ? clearTabBridgeState(tabId)
          : clearRestrictedTabDebuggerState(tabId);
      })
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        `Window ${windowId} cleanup failed`
      );
  }

  async function clearRestrictedTabDebuggerState(tabId: number) {
    const errors: unknown[] = [];
    await clearDebuggerState(tabId, errors);
    deps.clearFrames?.(tabId);
    if (errors.length) throw new AggregateError(errors, `Tab ${tabId} cleanup failed`);
  }

  return {
    clearTabBridgeState,
    clearWindowBridgeState,
    clearRemovedTabState,
    rollbackAllPatchesForTab,
  };
}

/** Coordinate Chrome's detach/attach move events so tabs that land in the
enabled window keep valid state, while tabs that leave it are fully cleaned. */
export function createTabMoveCleanupController(deps: {
  getEnabledWindowId: () => number | null;
  isTabOutsideEnabledWindow: (tabId: number) => Promise<boolean>;
  cancelNavigationWaitsForMove: (tabId: number) => void;
  cancelNavigationWaitsForRemoval: (tabId: number) => void;
  clearDialogState: (tabId: number) => void;
  disableTabInstrumentation: (tabId: number) => Promise<void>;
  resumeTabInstrumentation: (tabId: number) => Promise<void>;
  clearTabBridgeState: (tabId: number, shouldContinue?: () => Promise<boolean>) => Promise<void>;
  clearRemovedTabState: (tabId: number) => Promise<void>;
}): {
  handleDetached: (tabId: number, detachInfo: { oldWindowId: number }) => void;
  handleAttached: (tabId: number, attachInfo: { newWindowId: number }) => Promise<void>;
  handleRemoved: (tabId: number) => Promise<void>;
} {
  const detachedFromEnabledWindow: Set<number> = new Set();

  const instrumentationPauses: Map<number, Promise<void>> = new Map();

  function handleDetached(tabId: number, detachInfo: { oldWindowId: number }) {
    detachedFromEnabledWindow.delete(tabId);
    if (detachInfo.oldWindowId !== deps.getEnabledWindowId()) return;
    detachedFromEnabledWindow.add(tabId);
    deps.cancelNavigationWaitsForMove(tabId);
    const pause = deps.disableTabInstrumentation(tabId).finally(() => {
      if (instrumentationPauses.get(tabId) === pause) instrumentationPauses.delete(tabId);
    });
    instrumentationPauses.set(tabId, pause);
  }

  async function handleAttached(tabId: number, attachInfo: { newWindowId: number }) {
    const leftEnabledWindow = detachedFromEnabledWindow.delete(tabId);
    if (!leftEnabledWindow) return;
    await instrumentationPauses.get(tabId);
    if (attachInfo.newWindowId === deps.getEnabledWindowId()) {
      await deps.resumeTabInstrumentation(tabId);
      return;
    }
    if (!(await deps.isTabOutsideEnabledWindow(tabId))) return;
    if (attachInfo.newWindowId === deps.getEnabledWindowId()) return;

    await deps.clearTabBridgeState(tabId, () => deps.isTabOutsideEnabledWindow(tabId));
  }

  async function handleRemoved(tabId: number) {
    detachedFromEnabledWindow.delete(tabId);
    instrumentationPauses.delete(tabId);
    deps.cancelNavigationWaitsForRemoval(tabId);
    deps.clearDialogState(tabId);
    await deps.clearRemovedTabState(tabId);
  }

  return { handleDetached, handleAttached, handleRemoved };
}
