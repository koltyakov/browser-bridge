// @ts-check

import { randomUUID } from 'node:crypto';
import { sanitizeIncidentalText } from '../../protocol/src/index.js';
import { parseWindowActionRequest } from '../../protocol/src/window-actions.js';
import { writeJsonLine } from './framing.js';

/** @typedef {import('./daemon.js').ClientSocket} ClientSocket */
/** @typedef {{ source: ClientSocket, target: ClientSocket, finish: (error: string | null) => void }} PendingWindowAction */

/** Relay only user UI actions between authenticated local extensions. */
export class WindowActionRouter {
  /** @param {Map<string, ClientSocket>} extensions */
  constructor(extensions) {
    this.extensions = extensions;
    /** @type {Map<string, PendingWindowAction>} */
    this.pending = new Map();
  }

  /**
   * @param {ClientSocket} source
   * @param {Record<string, unknown>} message
   * @returns {Promise<void>}
   */
  async request(source, message) {
    const request = parseWindowActionRequest(message);
    const target = request ? this.extensions.get(request.extensionId) : null;
    /** @type {string | null} */
    let error = null;
    if (
      !request ||
      source.__role !== 'extension' ||
      !source.__windowActions ||
      this.extensions.get(source.__extensionId ?? '') !== source
    ) {
      error = 'Invalid window action request.';
    } else if (!target || target.destroyed || target === source) {
      error = 'The other browser disconnected. Refresh the list and try again.';
    } else if (!target.__windowActions || !target.__enabledWindow) {
      error = "Update the other browser's extension and native host to control its window.";
    } else if (
      !target.__accessEnabled ||
      target.__enabledWindow.windowId !== request.windowId ||
      target.__enabledWindow.enabledAt !== request.enabledAt
    ) {
      error = 'Window access changed. Refresh the list and try again.';
    } else if (
      this.pending.size >= 64 ||
      [...this.pending.values()].filter((entry) => entry.source === source).length >= 16
    ) {
      error = 'Too many window actions are pending. Try again shortly.';
    } else {
      const requestId = randomUUID();
      error = await new Promise((resolve) => {
        const timer = setTimeout(
          () => finish('The other browser did not respond. Try again.'),
          5_000
        );
        /** @param {string | null} failure */
        const finish = (failure) => {
          if (!this.pending.delete(requestId)) return;
          clearTimeout(timer);
          resolve(failure);
        };
        this.pending.set(requestId, { source, target, finish });
        void writeJsonLine(target, {
          type: 'extension.window_action.command',
          ...request,
          requestId,
        }).catch(() => finish('The other browser disconnected. Try again.'));
      });
    }
    if (!source.destroyed) {
      await writeJsonLine(source, {
        type: 'extension.window_action.response',
        requestId:
          request?.requestId ??
          (typeof message.requestId === 'string' ? message.requestId.slice(0, 80) : 'invalid'),
        ok: error === null,
        ...(error ? { error } : {}),
      });
    }
  }

  /**
   * @param {ClientSocket} source
   * @param {Record<string, unknown>} message
   * @returns {void}
   */
  result(source, message) {
    const pending =
      typeof message.requestId === 'string' ? this.pending.get(message.requestId) : null;
    if (!pending || pending.target !== source) return;
    pending.finish(
      message.ok === true
        ? null
        : typeof message.error === 'string'
          ? sanitizeIncidentalText(message.error).slice(0, 200) || 'Window action failed.'
          : 'Window action failed.'
    );
  }

  /** @param {ClientSocket} socket @returns {void} */
  disconnect(socket) {
    for (const pending of this.pending.values()) {
      if (pending.source === socket || pending.target === socket)
        pending.finish('The browser disconnected. Try again.');
    }
  }

  /** @returns {void} */
  clear() {
    for (const pending of this.pending.values()) pending.finish('The daemon stopped. Try again.');
  }
}
