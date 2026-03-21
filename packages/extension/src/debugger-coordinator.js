// @ts-check

/** @typedef {{ tabId: number }} DebuggerTarget */
/** @typedef {(target: DebuggerTarget, protocolVersion: string) => Promise<void>} DebuggerAttach */
/** @typedef {(target: DebuggerTarget) => Promise<void>} DebuggerDetach */

/**
 * Serialize Chrome debugger sessions per tab so concurrent bridge requests do
 * not race on `chrome.debugger.attach`.
 */
export class TabDebuggerCoordinator {
  /**
   * @param {{
   *   attach: DebuggerAttach,
   *   detach: DebuggerDetach,
   *   protocolVersion?: string
   * }} options
   */
  constructor({ attach, detach, protocolVersion = '1.3' }) {
    this.attach = attach;
    this.detach = detach;
    this.protocolVersion = protocolVersion;
    /** @type {Map<number, Promise<void>>} */
    this.pendingByTab = new Map();
  }

  /**
   * Run one debugger-backed task for a tab once earlier tasks for that tab
   * have finished.
   *
   * @template T
   * @param {number} tabId
   * @param {(target: DebuggerTarget) => Promise<T>} task
   * @returns {Promise<T>}
   */
  async run(tabId, task) {
    const previous = this.pendingByTab.get(tabId) ?? Promise.resolve();
    /** @type {(value?: void | PromiseLike<void>) => void} */
    let releaseTurn = () => {};
    const turn = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    const queuedTurn = previous.catch(() => {}).then(() => turn);
    this.pendingByTab.set(tabId, queuedTurn);

    await previous.catch(() => {});

    const target = { tabId };
    let attached = false;
    /** @type {T | undefined} */
    let result;
    /** @type {unknown} */
    let taskError = null;
    /** @type {unknown} */
    let detachError = null;

    try {
      await this.attach(target, this.protocolVersion);
      attached = true;
      result = await task(target);
    } catch (error) {
      taskError = error;
    }

    if (attached) {
      try {
        await this.detach(target);
      } catch (error) {
        detachError = error;
      }
    }

    releaseTurn();
    if (this.pendingByTab.get(tabId) === queuedTurn) {
      this.pendingByTab.delete(tabId);
    }

    if (taskError) {
      throw taskError;
    }
    if (detachError) {
      throw detachError;
    }
    return /** @type {T} */ (result);
  }
}
