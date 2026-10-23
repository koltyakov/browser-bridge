import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';
import { createCdpKeyPressEventPair } from './background-helpers.js';

export type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
export type ResolvedTabTarget = import('./background-state.js').ResolvedTabTarget;
export type DebuggerTarget = { tabId: number };
export type InputResolutionMetadata =
  import('../../../protocol/src/types.js').InputResolutionMetadata;

export type NativeResolution = {
  elementRef: string;
  point: { x: number; y: number };
  resolution: InputResolutionMetadata;
  value?: string;
};

export type NativeDragResult = {
  sourceRef: string;
  destinationRef: string;
  dragged: true;
  resolution: { source: InputResolutionMetadata; destination: InputResolutionMetadata };
  execution: Record<string, unknown>;
};

const CDP_INPUT_METHODS = new Set([
  'input.click',
  'input.hover',
  'input.drag',
  'input.type',
  'input.fill',
  'input.press_key',
  'input.touch',
]);

export type NativeTouchContact = {
  id: number;
  start: { x: number; y: number };
  end: { x: number; y: number } | null;
  current: { x: number; y: number };
  elementRef: string | null;
};

export function createBackgroundInputController(dependencies: {
  captureAccess?: () => () => void;
  getTab: (tabId: number) => Promise<Pick<chrome.tabs.Tab, 'active'>>;
  runWithDebugger: <T>(
    tabId: number,
    operation: (target: DebuggerTarget) => Promise<T>,
    options?: { retryDetached?: boolean }
  ) => Promise<T>;
  sendCommand: (
    target: DebuggerTarget,
    method: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;
  sendTabMessage: (
    tabId: number,
    message: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<unknown>;
  contentScriptTimeoutMs: number;
}) {
  async function handleNativeInput(
    request: BridgeRequest,
    tab: ResolvedTabTarget,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const assertAccess = dependencies.captureAccess?.() ?? (() => {});
    if (!CDP_INPUT_METHODS.has(request.method)) {
      throw new BridgeError(
        ERROR_CODES.INPUT_UNSUPPORTED,
        `${request.method} does not support executionMode=cdp.`,
        { method: request.method, executionMode: 'cdp' }
      );
    }

    if (
      ['input.click', 'input.hover', 'input.drag', 'input.touch'].includes(request.method) &&
      !(await dependencies.getTab(tab.tabId)).active
    ) {
      throw new BridgeError(
        ERROR_CODES.INPUT_UNSUPPORTED,
        'Chrome does not deliver native pointer input to an inactive tab. Use executionMode=dom when trusted input is unnecessary, or ask permission to activate this tab before using CDP input.',
        { reason: 'inactive_native_pointer_target', tabId: tab.tabId }
      );
    }

    const observe = params.observe as { settleMs?: unknown } | null | undefined;
    return dependencies.runWithDebugger(
      tab.tabId,
      async (debuggerTarget) => {
        assertAccess();
        const observationId = observe ? await beginObservation(tab.tabId) : null;
        assertAccess();
        const result = await executeNative(debuggerTarget);
        if (observationId) {
          result.effects = await finishObservation(
            tab.tabId,
            observationId,
            Number(observe?.settleMs) || 0,
            typeof result.elementRef === 'string' ? result.elementRef : null
          );
        }
        return result;
      },
      { retryDetached: false }
    );

    async function executeNative(debuggerTarget: DebuggerTarget): Promise<Record<string, unknown>> {
      switch (request.method) {
        case 'input.click':
          return click(debuggerTarget, tab.tabId, params);
        case 'input.hover':
          return hover(debuggerTarget, tab.tabId, params);
        case 'input.drag':
          return drag(debuggerTarget, tab.tabId, params);
        case 'input.type':
          return type(debuggerTarget, tab.tabId, params, false);
        case 'input.fill':
          return type(debuggerTarget, tab.tabId, params, true);
        case 'input.press_key':
          return pressKey(debuggerTarget, tab.tabId, params);
        case 'input.touch':
          return touch(debuggerTarget, tab.tabId, params);
        default:
          throw new BridgeError(ERROR_CODES.INPUT_UNSUPPORTED, 'Unsupported native input method.');
      }
    }
  }

  /** Start content-side effect observation before debugger input. Observation
is best effort: an unscriptable page simply reports no effects. */
  async function beginObservation(tabId: number): Promise<string | null> {
    try {
      const response = await dependencies.sendTabMessage(
        tabId,
        { type: 'bridge.execute', method: 'input.observe_start', params: {} },
        dependencies.contentScriptTimeoutMs
      );
      const started = unwrapContentResponse(response);
      return typeof started.observationId === 'string' ? started.observationId : null;
    } catch {
      return null;
    }
  }

  async function finishObservation(
    tabId: number,
    observationId: string,
    settleMs: number,
    elementRef: string | null
  ): Promise<Record<string, unknown>> {
    const boundedSettleMs = Math.min(Math.max(settleMs, 0), 5_000);
    try {
      const response = await dependencies.sendTabMessage(
        tabId,
        {
          type: 'bridge.execute',
          method: 'input.observe_finish',
          params: { observationId, settleMs: boundedSettleMs, elementRef },
        },
        dependencies.contentScriptTimeoutMs + boundedSettleMs
      );
      return unwrapContentResponse(response);
    } catch {
      // The page may have navigated away mid-settle.
      return { navigation: 'unloading', changed: true };
    }
  }

  async function click(target: DebuggerTarget, tabId: number, params: Record<string, unknown>) {
    const resolved = await resolveNative(
      tabId,
      params.target,
      'pointer',
      params.recoverStale,
      params.timeoutMs
    );
    const button = params.button === 'middle' || params.button === 'right' ? params.button : 'left';
    const clickCount = Number(params.clickCount) === 2 ? 2 : 1;
    const modifiers = toModifierMask(params.modifiers);
    const buttons = toButtonMask(button);
    const holdMs = toHoldMs(params.holdMs);
    await sendMouse(target, 'mouseMoved', resolved.point, 'none', 0, modifiers, 0);
    for (let sequence = 1; sequence <= clickCount; sequence += 1) {
      await sendMouse(target, 'mousePressed', resolved.point, button, buttons, modifiers, sequence);
      try {
        if (holdMs > 0) await sleep(holdMs);
      } finally {
        await sendMouse(target, 'mouseReleased', resolved.point, button, 0, modifiers, sequence);
      }
    }
    return {
      elementRef: resolved.elementRef,
      clicked: true,
      button,
      clickCount,
      ...(holdMs > 0 ? { holdMs } : {}),
      resolution: resolved.resolution,
      execution: executionMetadata(resolved.point),
    };
  }

  /** Press one key through CDP so the page receives trusted keyboard events
(user activation included). A target is focused first; otherwise the key
goes to whatever currently has focus. */
  async function pressKey(target: DebuggerTarget, tabId: number, params: Record<string, unknown>) {
    const targetParams =
      params.target && typeof params.target === 'object'
        ? (params.target as { elementRef?: string; selector?: string })
        : undefined;

    const resolved: NativeResolution | null =
      targetParams?.elementRef || targetParams?.selector
        ? await resolveNative(tabId, targetParams, 'focus', params.recoverStale, params.timeoutMs)
        : null;

    let events: Array<Record<string, unknown>>;
    try {
      events = createCdpKeyPressEventPair({ key: params.key, modifiers: params.modifiers ?? [] });
    } catch (error) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        error instanceof Error ? error.message : String(error)
      );
    }
    const holdMs = toHoldMs(params.holdMs);
    const [keyDown, keyUp] = events;
    await dependencies.sendCommand(target, 'Input.dispatchKeyEvent', keyDown);
    try {
      if (holdMs > 0) await sleep(holdMs);
    } finally {
      await dependencies.sendCommand(target, 'Input.dispatchKeyEvent', keyUp);
    }
    return {
      elementRef: resolved?.elementRef ?? null,
      key: keyDown.key,
      code: keyDown.code,
      ...(holdMs > 0 ? { holdMs } : {}),
      ...(resolved ? { resolution: resolved.resolution } : {}),
      execution: executionMetadata(resolved?.point ?? null),
    };
  }

  /** Put all touch points down in one CDP touchStart, optionally move them in
interpolated touchMove events across holdMs, then lift them together. */
  async function touch(target: DebuggerTarget, tabId: number, params: Record<string, unknown>) {
    const points = Array.isArray(params.points) ? params.points : [];
    if (!points.length) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'points must contain at least one touch point.'
      );
    }

    const contacts: NativeTouchContact[] = [];
    for (const [index, point] of points.entries()) {
      const record = point && typeof point === 'object' ? (point as Record<string, unknown>) : {};
      const start = await resolveTouchPosition(tabId, record, params.recoverStale);
      const end = record.to
        ? await resolveTouchPosition(tabId, record.to, params.recoverStale)
        : null;
      contacts.push({
        id: index,
        start: start.point,
        end: end ? end.point : null,
        current: { ...start.point },
        elementRef: start.elementRef,
      });
    }
    const holdMs = toHoldMs(params.holdMs);
    const moveSteps = Math.min(Math.max(Math.trunc(Number(params.moveSteps) || 10), 1), 60);
    const moving = contacts.some((contact) => contact.end);

    await sendTouch(target, 'touchStart', contacts);
    try {
      if (moving) {
        for (let step = 1; step <= moveSteps; step += 1) {
          await sleep(holdMs / moveSteps);
          const progress = step / moveSteps;
          for (const contact of contacts) {
            if (!contact.end) continue;
            contact.current = {
              x: contact.start.x + (contact.end.x - contact.start.x) * progress,
              y: contact.start.y + (contact.end.y - contact.start.y) * progress,
            };
          }
          await sendTouch(target, 'touchMove', contacts);
        }
      } else if (holdMs > 0) {
        await sleep(holdMs);
      }
    } finally {
      await sendTouch(target, 'touchEnd', []);
    }
    return {
      touched: true,
      pointCount: contacts.length,
      points: contacts.map((contact) => ({
        elementRef: contact.elementRef,
        x: Math.round(contact.start.x),
        y: Math.round(contact.start.y),
        ...(contact.end ? { toX: Math.round(contact.end.x), toY: Math.round(contact.end.y) } : {}),
      })),
      holdMs,
      execution: executionMetadata(contacts[0].start),
    };
  }

  async function resolveTouchPosition(
    tabId: number,
    position: unknown,
    recoverStale: unknown
  ): Promise<{ point: { x: number; y: number }; elementRef: string | null }> {
    const record =
      position && typeof position === 'object' ? (position as Record<string, unknown>) : {};
    const targetParams =
      record.target && typeof record.target === 'object'
        ? record.target
        : (null as import('../../../protocol/src/types.js').InputTarget | null);
    if (targetParams) {
      const resolved = await resolveNative(tabId, targetParams, 'pointer', recoverStale);
      return { point: resolved.point, elementRef: resolved.elementRef };
    }
    const x = Number(record.x);
    const y = Number(record.y);
    if (record.x == null || record.y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'Touch point needs a target or numeric x and y.'
      );
    }
    return { point: { x, y }, elementRef: null };
  }

  async function sendTouch(
    target: DebuggerTarget,
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    contacts: NativeTouchContact[]
  ) {
    await dependencies.sendCommand(target, 'Input.dispatchTouchEvent', {
      type,
      touchPoints: contacts.map((contact) => ({
        x: contact.current.x,
        y: contact.current.y,
        id: contact.id,
        radiusX: 1,
        radiusY: 1,
        force: 0.5,
      })),
    });
  }

  async function hover(target: DebuggerTarget, tabId: number, params: Record<string, unknown>) {
    const resolved = await resolveNative(
      tabId,
      params.target,
      'pointer',
      params.recoverStale,
      params.timeoutMs
    );
    await sendMouse(
      target,
      'mouseMoved',
      resolved.point,
      'none',
      0,
      toModifierMask(params.modifiers),
      0
    );
    const duration = Math.min(Math.max(Number(params.duration) || 0, 0), 5_000);
    if (duration > 0) await new Promise((resolve) => setTimeout(resolve, duration));
    return {
      elementRef: resolved.elementRef,
      hovered: true,
      resolution: resolved.resolution,
      execution: executionMetadata(resolved.point),
    };
  }

  async function drag(
    target: DebuggerTarget,
    tabId: number,
    params: Record<string, unknown>
  ): Promise<NativeDragResult> {
    const source = await resolveNative(
      tabId,
      params.source,
      'pointer',
      params.recoverStale,
      params.timeoutMs
    );
    await sendMouse(target, 'mouseMoved', source.point, 'none', 0, 0, 0);
    let pressed = false;

    let operationError: unknown = null;

    let destination: NativeResolution | null = null;
    try {
      await sendMouse(target, 'mousePressed', source.point, 'left', 1, 0, 1);
      pressed = true;
      destination = await resolveNative(
        tabId,
        params.destination,
        'pointer',
        params.recoverStale,
        params.timeoutMs
      );
      const end = {
        x: destination.point.x + finiteNumber(params.offsetX),
        y: destination.point.y + finiteNumber(params.offsetY),
      };
      const steps = 10;
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        await sendMouse(
          target,
          'mouseMoved',
          {
            x: source.point.x + (end.x - source.point.x) * progress,
            y: source.point.y + (end.y - source.point.y) * progress,
          },
          'left',
          1,
          0,
          0
        );
      }
    } catch (error) {
      operationError = error;
    } finally {
      if (pressed) {
        const releasePoint = destination
          ? {
              x: destination.point.x + finiteNumber(params.offsetX),
              y: destination.point.y + finiteNumber(params.offsetY),
            }
          : source.point;
        try {
          await sendMouse(target, 'mouseReleased', releasePoint, 'left', 0, 0, 1);
        } catch (releaseError) {
          if (!operationError) operationError = releaseError;
        }
      }
    }
    if (operationError) throw operationError;
    if (!destination) {
      throw new BridgeError(
        ERROR_CODES.INTERNAL_ERROR,
        'Native drag completed without a destination resolution.'
      );
    }
    const resolvedDestination = destination;
    const endPoint = {
      x: resolvedDestination.point.x + finiteNumber(params.offsetX),
      y: resolvedDestination.point.y + finiteNumber(params.offsetY),
    };
    return {
      sourceRef: source.elementRef,
      destinationRef: resolvedDestination.elementRef,
      dragged: true,
      resolution: {
        source: source.resolution,
        destination: resolvedDestination.resolution,
      },
      execution: executionMetadata(endPoint),
    };
  }

  async function type(
    target: DebuggerTarget,
    tabId: number,
    params: Record<string, unknown>,
    fill: boolean
  ) {
    const resolved = await resolveNative(
      tabId,
      params.target,
      'editable',
      params.recoverStale,
      params.timeoutMs
    );
    const shouldClear = fill || params.clear === true;
    const text = String(fill ? (params.value ?? '') : (params.text ?? ''));
    let mutationDispatched = false;
    let insertedLength = 0;

    let postMutationStatus: string | null = null;

    await revalidateEditable(tabId, resolved.elementRef);
    if (shouldClear) {
      await clearEditable(target);
      mutationDispatched = true;
    }
    if (text && !postMutationStatus) {
      try {
        await revalidateEditable(tabId, resolved.elementRef);
      } catch (error) {
        if (!mutationDispatched || !isTargetInvalidationError(error)) throw error;
        postMutationStatus = getInvalidationStatus(error);
      }
      if (!postMutationStatus) {
        await dependencies.sendCommand(target, 'Input.insertText', { text });
        mutationDispatched = true;
        insertedLength = text.length;
      }
    }
    if (!fill && params.submit === true && !postMutationStatus) {
      try {
        await revalidateEditable(tabId, resolved.elementRef);
      } catch (error) {
        if (!mutationDispatched || !isTargetInvalidationError(error)) throw error;
        postMutationStatus = getInvalidationStatus(error);
      }
      if (!postMutationStatus) {
        await dispatchKey(target, 'Enter', 'Enter', 0);
        mutationDispatched = true;
      }
    }

    const readResult = await readValueAfterMutation(
      tabId,
      resolved,
      mutationDispatched,
      postMutationStatus
    );
    return fill
      ? {
          elementRef: readResult.elementRef,
          value: readResult.value,
          mode: 'cdp',
          postMutation: readResult.postMutation,
          resolution: resolved.resolution,
          execution: executionMetadata(resolved.point),
        }
      : {
          elementRef: readResult.elementRef,
          typed: insertedLength,
          value: readResult.value,
          postMutation: readResult.postMutation,
          resolution: resolved.resolution,
          execution: executionMetadata(resolved.point),
        };
  }

  async function clearEditable(target: DebuggerTarget) {
    await dependencies.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 2,
      commands: ['SelectAll'],
    });
    await dependencies.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 2,
    });
    await dependencies.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      commands: ['DeleteBackward'],
    });
    await dependencies.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
    });
  }

  async function dispatchKey(target: DebuggerTarget, key: string, code: string, modifiers: number) {
    await dependencies.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      modifiers,
    });
    await dependencies.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      modifiers,
    });
  }

  async function revalidateEditable(tabId: number, elementRef: string) {
    const response = await dependencies.sendTabMessage(
      tabId,
      {
        type: 'bridge.execute',
        method: 'input.revalidate_native',
        params: { elementRef },
      },
      dependencies.contentScriptTimeoutMs
    );
    unwrapContentResponse(response);
  }

  async function readValueAfterMutation(
    tabId: number,
    resolved: NativeResolution,
    mutationDispatched: boolean,
    priorStatus: string | null
  ) {
    if (!mutationDispatched) {
      return {
        elementRef: resolved.elementRef,
        value: resolved.value ?? '',
        postMutation: { status: 'not-dispatched', verified: true },
      };
    }
    if (priorStatus) {
      return {
        elementRef: resolved.elementRef,
        value: null,
        postMutation: { status: priorStatus, verified: false },
      };
    }
    try {
      const readResult = await readValue(tabId, resolved.elementRef);
      return {
        ...readResult,
        postMutation: { status: 'read-back', verified: true },
      };
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== ERROR_CODES.ELEMENT_STALE) throw error;
      return {
        elementRef: resolved.elementRef,
        value: null,
        postMutation: { status: 'target-rerendered', verified: false },
      };
    }
  }

  async function sendMouse(
    target: DebuggerTarget,
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
    point: { x: number; y: number },
    button: 'none' | 'left' | 'middle' | 'right',
    buttons: number,
    modifiers: number,
    clickCount: number
  ) {
    await dependencies.sendCommand(target, 'Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button,
      buttons,
      modifiers,
      clickCount,
    });
  }

  async function resolveNative(
    tabId: number,
    target: unknown,
    kind: 'pointer' | 'editable' | 'focus',
    recoverStale: unknown,
    timeoutMs?: unknown
  ): Promise<NativeResolution> {
    const waitMs = Math.min(Math.max(Number(timeoutMs) || 0, 0), 15_000);
    const response = await dependencies.sendTabMessage(
      tabId,
      {
        type: 'bridge.execute',
        method: 'input.resolve_native',
        params: { target, kind, recoverStale: recoverStale === true, timeoutMs: waitMs },
      },
      dependencies.contentScriptTimeoutMs + waitMs
    );
    return unwrapContentResponse(response) as NativeResolution;
  }

  async function readValue(tabId: number, elementRef: string) {
    const response = await dependencies.sendTabMessage(
      tabId,
      {
        type: 'bridge.execute',
        method: 'input.read_value',
        params: { elementRef },
      },
      dependencies.contentScriptTimeoutMs
    );
    return unwrapContentResponse(response) as { elementRef: string; value: string };
  }

  return { handleNativeInput };
}

function unwrapContentResponse(response: unknown): Record<string, unknown> {
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>;
    if (record.error) {
      const error = record.error;
      if (error && typeof error === 'object') {
        const structured = error as Record<string, unknown>;
        throw new BridgeError(
          typeof structured.code === 'string'
            ? (structured.code as import('../../../protocol/src/types.js').ErrorCode)
            : ERROR_CODES.INTERNAL_ERROR,
          typeof structured.message === 'string'
            ? structured.message
            : 'Native input resolution failed.',
          structured.details ?? null
        );
      }
      throw new BridgeError(ERROR_CODES.INTERNAL_ERROR, String(error));
    }
    return record;
  }
  throw new BridgeError(ERROR_CODES.INTERNAL_ERROR, 'Native input resolution returned no result.');
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toModifierMask(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let mask = 0;
  if (value.includes('Alt')) mask |= 1;
  if (value.includes('Control')) mask |= 2;
  if (value.includes('Meta')) mask |= 4;
  if (value.includes('Shift')) mask |= 8;
  return mask;
}

function toButtonMask(button: 'left' | 'middle' | 'right'): number {
  if (button === 'right') return 2;
  if (button === 'middle') return 4;
  return 1;
}

function isTargetInvalidationError(error: unknown): boolean {
  const invalidationCodes = [
    ERROR_CODES.ELEMENT_STALE,
    ERROR_CODES.INPUT_FOCUS_CHANGED,
    ERROR_CODES.INPUT_INVALID_TARGET,
  ] as string[];
  return error instanceof BridgeError && invalidationCodes.includes(error.code);
}

function getInvalidationStatus(error: unknown): string {
  if (error instanceof BridgeError && error.code === ERROR_CODES.INPUT_FOCUS_CHANGED) {
    return 'focus-changed';
  }
  return 'target-rerendered';
}

function executionMetadata(point: { x: number; y: number } | null) {
  return {
    requestedMode: 'cdp',
    actualMode: 'cdp',
    fallbackReason: null,
    debuggerUsed: true,
    ...(point ? { targetCoordinates: point } : {}),
  };
}

function toHoldMs(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), 0), 10_000) : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
