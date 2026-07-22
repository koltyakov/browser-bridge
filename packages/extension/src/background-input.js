// @ts-check

import { BridgeError, ERROR_CODES } from '../../protocol/src/index.js';

/** @typedef {import('../../protocol/src/types.js').BridgeRequest} BridgeRequest */
/** @typedef {import('./background-state.js').ResolvedTabTarget} ResolvedTabTarget */
/** @typedef {{ tabId: number }} DebuggerTarget */
/** @typedef {import('../../protocol/src/types.js').InputResolutionMetadata} InputResolutionMetadata */

/**
 * @typedef {{
 *   elementRef: string,
 *   point: { x: number, y: number },
 *   resolution: InputResolutionMetadata,
 *   value?: string
 * }} NativeResolution
 */

/**
 * @typedef {{
 *   sourceRef: string,
 *   destinationRef: string,
 *   dragged: true,
 *   resolution: { source: InputResolutionMetadata, destination: InputResolutionMetadata },
 *   execution: Record<string, unknown>
 * }} NativeDragResult
 */

const CDP_INPUT_METHODS = new Set([
  'input.click',
  'input.hover',
  'input.drag',
  'input.type',
  'input.fill',
]);

/**
 * @param {{
 *   runWithDebugger: <T>(tabId: number, operation: (target: DebuggerTarget) => Promise<T>, options?: { retryDetached?: boolean }) => Promise<T>,
 *   sendCommand: (target: DebuggerTarget, method: string, params: Record<string, unknown>) => Promise<unknown>,
 *   sendTabMessage: (tabId: number, message: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>,
 *   contentScriptTimeoutMs: number
 * }} dependencies
 */
export function createBackgroundInputController(dependencies) {
  /**
   * @param {BridgeRequest} request
   * @param {ResolvedTabTarget} tab
   * @param {Record<string, unknown>} params
   * @returns {Promise<Record<string, unknown>>}
   */
  async function handleNativeInput(request, tab, params) {
    if (!CDP_INPUT_METHODS.has(request.method)) {
      throw new BridgeError(
        ERROR_CODES.INPUT_UNSUPPORTED,
        `${request.method} does not support executionMode=cdp.`,
        { method: request.method, executionMode: 'cdp' }
      );
    }

    return dependencies.runWithDebugger(
      tab.tabId,
      async (debuggerTarget) => {
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
          default:
            throw new BridgeError(
              ERROR_CODES.INPUT_UNSUPPORTED,
              'Unsupported native input method.'
            );
        }
      },
      { retryDetached: false }
    );
  }

  /** @param {DebuggerTarget} target @param {number} tabId @param {Record<string, unknown>} params */
  async function click(target, tabId, params) {
    const resolved = await resolveNative(tabId, params.target, 'pointer', params.recoverStale);
    const button = params.button === 'middle' || params.button === 'right' ? params.button : 'left';
    const clickCount = Number(params.clickCount) === 2 ? 2 : 1;
    const modifiers = toModifierMask(params.modifiers);
    const buttons = toButtonMask(button);
    await sendMouse(target, 'mouseMoved', resolved.point, 'none', 0, modifiers, 0);
    for (let sequence = 1; sequence <= clickCount; sequence += 1) {
      await sendMouse(target, 'mousePressed', resolved.point, button, buttons, modifiers, sequence);
      await sendMouse(target, 'mouseReleased', resolved.point, button, 0, modifiers, sequence);
    }
    return {
      elementRef: resolved.elementRef,
      clicked: true,
      button,
      clickCount,
      resolution: resolved.resolution,
      execution: executionMetadata(resolved.point),
    };
  }

  /** @param {DebuggerTarget} target @param {number} tabId @param {Record<string, unknown>} params */
  async function hover(target, tabId, params) {
    const resolved = await resolveNative(tabId, params.target, 'pointer', params.recoverStale);
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

  /**
   * @param {DebuggerTarget} target
   * @param {number} tabId
   * @param {Record<string, unknown>} params
   * @returns {Promise<NativeDragResult>}
   */
  async function drag(target, tabId, params) {
    const source = await resolveNative(tabId, params.source, 'pointer', params.recoverStale);
    await sendMouse(target, 'mouseMoved', source.point, 'none', 0, 0, 0);
    let pressed = false;
    /** @type {unknown} */
    let operationError = null;
    /** @type {NativeResolution | null} */
    let destination = null;
    try {
      await sendMouse(target, 'mousePressed', source.point, 'left', 1, 0, 1);
      pressed = true;
      destination = await resolveNative(tabId, params.destination, 'pointer', params.recoverStale);
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

  /**
   * @param {DebuggerTarget} target
   * @param {number} tabId
   * @param {Record<string, unknown>} params
   * @param {boolean} fill
   */
  async function type(target, tabId, params, fill) {
    const resolved = await resolveNative(tabId, params.target, 'editable', params.recoverStale);
    const shouldClear = fill || params.clear === true;
    const text = String(fill ? (params.value ?? '') : (params.text ?? ''));
    let mutationDispatched = false;
    let insertedLength = 0;
    /** @type {string | null} */
    let postMutationStatus = null;

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

  /** @param {DebuggerTarget} target */
  async function clearEditable(target) {
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

  /** @param {DebuggerTarget} target @param {string} key @param {string} code @param {number} modifiers */
  async function dispatchKey(target, key, code, modifiers) {
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

  /** @param {number} tabId @param {string} elementRef */
  async function revalidateEditable(tabId, elementRef) {
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

  /**
   * @param {number} tabId
   * @param {NativeResolution} resolved
   * @param {boolean} mutationDispatched
   * @param {string | null} priorStatus
   */
  async function readValueAfterMutation(tabId, resolved, mutationDispatched, priorStatus) {
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

  /**
   * @param {DebuggerTarget} target
   * @param {'mouseMoved' | 'mousePressed' | 'mouseReleased'} type
   * @param {{ x: number, y: number }} point
   * @param {'none' | 'left' | 'middle' | 'right'} button
   * @param {number} buttons
   * @param {number} modifiers
   * @param {number} clickCount
   */
  async function sendMouse(target, type, point, button, buttons, modifiers, clickCount) {
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

  /**
   * @param {number} tabId
   * @param {unknown} target
   * @param {'pointer' | 'editable'} kind
   * @param {unknown} recoverStale
   * @returns {Promise<NativeResolution>}
   */
  async function resolveNative(tabId, target, kind, recoverStale) {
    const response = await dependencies.sendTabMessage(
      tabId,
      {
        type: 'bridge.execute',
        method: 'input.resolve_native',
        params: { target, kind, recoverStale: recoverStale === true },
      },
      dependencies.contentScriptTimeoutMs
    );
    return /** @type {NativeResolution} */ (unwrapContentResponse(response));
  }

  /** @param {number} tabId @param {string} elementRef */
  async function readValue(tabId, elementRef) {
    const response = await dependencies.sendTabMessage(
      tabId,
      {
        type: 'bridge.execute',
        method: 'input.read_value',
        params: { elementRef },
      },
      dependencies.contentScriptTimeoutMs
    );
    return /** @type {{ elementRef: string, value: string }} */ (unwrapContentResponse(response));
  }

  return { handleNativeInput };
}

/** @param {unknown} response @returns {Record<string, unknown>} */
function unwrapContentResponse(response) {
  if (response && typeof response === 'object') {
    const record = /** @type {Record<string, unknown>} */ (response);
    if (record.error) {
      const error = record.error;
      if (error && typeof error === 'object') {
        const structured = /** @type {Record<string, unknown>} */ (error);
        throw new BridgeError(
          typeof structured.code === 'string'
            ? /** @type {import('../../protocol/src/types.js').ErrorCode} */ (structured.code)
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

/** @param {unknown} value @returns {number} */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** @param {unknown} value @returns {number} */
function toModifierMask(value) {
  if (!Array.isArray(value)) return 0;
  let mask = 0;
  if (value.includes('Alt')) mask |= 1;
  if (value.includes('Control')) mask |= 2;
  if (value.includes('Meta')) mask |= 4;
  if (value.includes('Shift')) mask |= 8;
  return mask;
}

/** @param {'left' | 'middle' | 'right'} button @returns {number} */
function toButtonMask(button) {
  if (button === 'right') return 2;
  if (button === 'middle') return 4;
  return 1;
}

/** @param {unknown} error @returns {boolean} */
function isTargetInvalidationError(error) {
  const invalidationCodes = /** @type {string[]} */ ([
    ERROR_CODES.ELEMENT_STALE,
    ERROR_CODES.INPUT_FOCUS_CHANGED,
    ERROR_CODES.INPUT_INVALID_TARGET,
  ]);
  return error instanceof BridgeError && invalidationCodes.includes(error.code);
}

/** @param {unknown} error @returns {string} */
function getInvalidationStatus(error) {
  if (error instanceof BridgeError && error.code === ERROR_CODES.INPUT_FOCUS_CHANGED) {
    return 'focus-changed';
  }
  return 'target-rerendered';
}

/** @param {{ x: number, y: number }} point */
function executionMetadata(point) {
  return {
    requestedMode: 'cdp',
    actualMode: 'cdp',
    fallbackReason: null,
    debuggerUsed: true,
    targetCoordinates: point,
  };
}
