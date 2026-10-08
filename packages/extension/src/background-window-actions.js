// @ts-check

import { parseWindowActionCommand } from '../../protocol/src/window-actions.js';
import { reportAsyncError } from './background-state.js';

/** @typedef {import('../../protocol/src/window-access.js').BrowserWindowAccess} BrowserWindowAccess */
/** @typedef {import('../../protocol/src/window-access.js').WindowActionCommand} WindowActionCommand */
/** @typedef {import('./background-state.js').ExtensionState} ExtensionState */

/**
 * @param {ExtensionState} state
 * @param {Pick<typeof chrome, 'windows'>} chromeObj
 * @param {{ disableWindowAccess: (windowId: number, enabledAt: number) => Promise<void> }} deps
 * @returns {{
 *   request: (action: import('../../protocol/src/window-access.js').WindowAction, entry: BrowserWindowAccess) => Promise<void>,
 *   handleMessage: (message: unknown) => boolean,
 *   disconnect: () => void,
 * }}
 */
export function createWindowActionsController(state, chromeObj, deps) {
  /** @type {Map<string, (error: string | null) => void>} */
  const pending = new Map();

  /** @param {WindowActionCommand} command @returns {Promise<void>} */
  async function apply(command) {
    const access = state.enabledWindow;
    if (!access || access.windowId !== command.windowId || access.enabledAt !== command.enabledAt) {
      throw new Error('Window access changed. Refresh the list and try again.');
    }
    if (command.action === 'disable') {
      await deps.disableWindowAccess(command.windowId, command.enabledAt);
      return;
    }
    const window = await chromeObj.windows.get(command.windowId);
    // Do not steal focus if the grant changed while Chrome resolved the window.
    if (
      state.enabledWindow?.windowId !== command.windowId ||
      state.enabledWindow.enabledAt !== command.enabledAt
    ) {
      throw new Error('Window access changed. Refresh the list and try again.');
    }
    await chromeObj.windows.update(command.windowId, {
      focused: true,
      ...(window.state === 'minimized' ? { state: 'normal' } : {}),
    });
  }

  /**
   * @param {import('../../protocol/src/window-access.js').WindowAction} action
   * @param {BrowserWindowAccess} entry
   * @returns {Promise<void>}
   */
  async function request(action, entry) {
    if (!entry.window)
      throw new Error(
        "Update the other browser's extension and native host to control its window."
      );
    const command = {
      requestId: crypto.randomUUID(),
      action,
      windowId: entry.window.windowId,
      enabledAt: entry.window.enabledAt,
    };
    if (entry.extensionId === 'local') return apply(command);
    if (!entry.canControl)
      throw new Error(
        "Update the other browser's extension and native host to control its window."
      );
    const port = state.nativePort;
    if (!port) throw new Error('Native host is disconnected.');
    if (pending.size >= 16)
      throw new Error('Too many window actions are pending. Try again shortly.');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish('Window action timed out. Update the daemon and native host, then try again.'),
        6_000
      );
      /** @param {string | null} error */
      const finish = (error) => {
        if (!pending.delete(command.requestId)) return;
        clearTimeout(timer);
        if (error) reject(new Error(error));
        else resolve(undefined);
      };
      pending.set(command.requestId, finish);
      try {
        port.postMessage({
          type: 'host.window_action.request',
          ...command,
          extensionId: entry.extensionId,
        });
      } catch {
        finish('Native host is disconnected.');
      }
    });
  }

  /** @param {unknown} value @returns {boolean} */
  function handleMessage(value) {
    if (!value || typeof value !== 'object') return false;
    const message = /** @type {Record<string, unknown>} */ (value);
    if (message.type === 'host.window_action.response') {
      if (typeof message.requestId === 'string')
        pending.get(message.requestId)?.(
          message.ok === true
            ? null
            : typeof message.error === 'string'
              ? message.error
              : 'Window action failed.'
        );
      return true;
    }
    if (message.type !== 'host.window_action.command') return false;
    const command = parseWindowActionCommand(message);
    if (!command) return true;
    const port = state.nativePort ?? state.pendingNativePort;
    if (!port) return true;
    void apply(command)
      .then(
        () =>
          port.postMessage({
            type: 'host.window_action.result',
            requestId: command.requestId,
            ok: true,
          }),
        /** @param {unknown} error */
        (error) =>
          port.postMessage({
            type: 'host.window_action.result',
            requestId: command.requestId,
            ok: false,
            error: error instanceof Error ? error.message : 'Window action failed.',
          })
      )
      .catch(reportAsyncError);
    return true;
  }

  /** @returns {void} */
  function disconnect() {
    for (const finish of pending.values()) finish('Native host is disconnected.');
  }

  return { request, handleMessage, disconnect };
}
