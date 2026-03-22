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
    /** @type {Map<number, number>} */
    this.holdsByTab = new Map();
  }

  /**
   * Run one serialized operation for a tab.
   *
   * @template T
   * @param {number} tabId
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  async runExclusive(tabId, task) {
    const previous = this.pendingByTab.get(tabId) ?? Promise.resolve();
    /** @type {(value?: void | PromiseLike<void>) => void} */
    let releaseTurn = () => {};
    const turn = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    const queuedTurn = previous.catch(() => {}).then(() => turn);
    this.pendingByTab.set(tabId, queuedTurn);

    await previous.catch(() => {});

    try {
      return await task();
    } finally {
      releaseTurn();
      if (this.pendingByTab.get(tabId) === queuedTurn) {
        this.pendingByTab.delete(tabId);
      }
    }
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
    return this.runExclusive(tabId, async () => {
      const target = { tabId };
      const held = (this.holdsByTab.get(tabId) ?? 0) > 0;
      let attachedForRun = false;
      /** @type {T | undefined} */
      let result;
      /** @type {unknown} */
      let taskError = null;
      /** @type {unknown} */
      let detachError = null;

      try {
        if (!held) {
          await this.attach(target, this.protocolVersion);
          attachedForRun = true;
        }
        result = await task(target);
      } catch (error) {
        taskError = error;
      }

      if (attachedForRun) {
        try {
          await this.detach(target);
        } catch (error) {
          detachError = error;
        }
      }

      if (taskError) {
        throw taskError;
      }
      if (detachError) {
        throw detachError;
      }
      return /** @type {T} */ (result);
    });
  }

  /**
   * Attach and keep a debugger session alive across multiple runs for the same
   * tab. Nested holds are reference-counted.
   *
   * @param {number} tabId
   * @param {(target: DebuggerTarget) => Promise<void>} [initialize]
   * @returns {Promise<void>}
   */
  async acquire(tabId, initialize = async () => {}) {
    await this.runExclusive(tabId, async () => {
      const target = { tabId };
      const holdCount = this.holdsByTab.get(tabId) ?? 0;
      if (holdCount === 0) {
        let attached = false;
        try {
          await this.attach(target, this.protocolVersion);
          attached = true;
          await initialize(target);
        } catch (error) {
          if (attached) {
            await this.detach(target).catch(() => {});
          }
          throw error;
        }
      }
      this.holdsByTab.set(tabId, holdCount + 1);
    });
  }

  /**
   * Release one persistent debugger hold for a tab.
   *
   * @param {number} tabId
   * @param {(target: DebuggerTarget) => Promise<void>} [cleanup]
   * @returns {Promise<void>}
   */
  async release(tabId, cleanup = async () => {}) {
    await this.runExclusive(tabId, async () => {
      const target = { tabId };
      const holdCount = this.holdsByTab.get(tabId) ?? 0;
      if (holdCount === 0) {
        return;
      }
      if (holdCount > 1) {
        this.holdsByTab.set(tabId, holdCount - 1);
        return;
      }

      this.holdsByTab.delete(tabId);
      let cleanupError = null;
      try {
        await cleanup(target);
      } catch (error) {
        cleanupError = error;
      }
      await this.detach(target);
      if (cleanupError) {
        throw cleanupError;
      }
    });
  }
}
