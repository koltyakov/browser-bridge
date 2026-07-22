// @ts-check

/** @typedef {{ tabId: number }} DebuggerTarget */
/** @typedef {(target: DebuggerTarget, protocolVersion: string) => Promise<void>} DebuggerAttach */
/** @typedef {(target: DebuggerTarget) => Promise<void>} DebuggerDetach */
/** @typedef {(target: DebuggerTarget) => Promise<void>} DebuggerInitialize */

const MAX_TRACKED_DIALOGS = 100;
const MAX_DIALOG_TEXT_LENGTH = 4_096;

/**
 * @typedef {{
 *   dialogId: string,
 *   type: 'alert' | 'confirm' | 'prompt' | 'beforeunload',
 *   message: string,
 *   defaultPrompt: string,
 *   messageTruncated: boolean,
 *   defaultPromptTruncated: boolean,
 *   openedAt: number
 * }} TrackedDialog
 */

/**
 * @typedef {{
 *   timeoutId: ReturnType<typeof setTimeout>,
 *   resolve: (dialog: TrackedDialog | null) => void
 * }} DialogWaiter
 */

/**
 * @typedef {{
 *   eventSequence: number,
 *   lastOpenedDialogId: string | null
 * }} DialogEventState
 */

/**
 * Serialize Chrome debugger sessions per tab so concurrent bridge requests do
 * not race on `chrome.debugger.attach`.
 */
export class TabDebuggerCoordinator {
  /**
   * @param {{
   *   attach: DebuggerAttach,
   *   detach: DebuggerDetach,
   *   initialize?: DebuggerInitialize,
   *   protocolVersion?: string,
   *   burstIdleMs?: number
   * }} options
   */
  constructor({
    attach,
    detach,
    initialize = async () => {},
    protocolVersion = '1.3',
    burstIdleMs = 5_000,
  }) {
    this.attach = attach;
    this.detach = detach;
    this.initialize = initialize;
    this.protocolVersion = protocolVersion;
    this.burstIdleMs = burstIdleMs;
    /** @type {Map<number, Promise<void>>} */
    this.pendingByTab = new Map();
    /** @type {Map<number, number>} */
    this.holdsByTab = new Map();
    /** @type {Map<number, ReturnType<typeof setTimeout>>} */
    this.burstTimers = new Map();
    /** @type {Set<number>} */
    this.attachedTabs = new Set();
    /** @type {Map<number, TrackedDialog>} */
    this.dialogsByTab = new Map();
    /** @type {Map<number, Set<DialogWaiter>>} */
    this.dialogWaitersByTab = new Map();
    /** @type {Map<number, DialogEventState>} */
    this.dialogEventsByTab = new Map();
    this.dialogIdentityPrefix = globalThis.crypto.randomUUID();
    this.nextDialogGeneration = 0;
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
   * @param {{ retryDetached?: boolean }} [options]
   * @returns {Promise<T>}
   */
  async run(tabId, task, options = {}) {
    return this.runExclusive(tabId, async () => {
      const target = { tabId };
      const held = (this.holdsByTab.get(tabId) ?? 0) > 0;
      const hasBurst = this._consumeBurstTimer(tabId);
      /** @type {T | undefined} */
      let result;
      /** @type {unknown} */
      let taskError = null;
      let detached = false;

      try {
        if (!held && !hasBurst) {
          await this._attach(target);
        }
        result = await task(target);
      } catch (error) {
        if (isDebuggerDetachedError(error)) {
          this.markDetached(tabId);
          detached = true;
          if (options.retryDetached === false) {
            taskError = error;
          } else {
            try {
              await this._attach(target);
              detached = false;
              result = await task(target);
            } catch (retryError) {
              taskError = retryError;
            }
          }
        } else {
          taskError = error;
        }
      }

      // Schedule a burst-idle detach instead of detaching immediately.
      if (!held && !detached && this.attachedTabs.has(tabId)) {
        this._resetBurstTimer(tabId, target);
      }

      if (taskError) {
        throw taskError;
      }
      return /** @type {T} */ (result);
    });
  }

  /**
   * Forget a debugger session that Chrome detached outside this coordinator.
   *
   * @param {number} tabId
   * @returns {void}
   */
  markDetached(tabId) {
    const existing = this.burstTimers.get(tabId);
    if (existing) clearTimeout(existing);
    this.burstTimers.delete(tabId);
    this.holdsByTab.delete(tabId);
    this.attachedTabs.delete(tabId);
    this.clearDialogState(tabId);
  }

  /**
   * Track Page-domain dialog events without exposing their text through logs or
   * page-state summaries. Only events observed while the debugger is attached
   * are knowable; detachment clears that knowledge.
   *
   * @param {number} tabId
   * @param {string} method
   * @param {unknown} params
   * @returns {void}
   */
  handleEvent(tabId, method, params) {
    if (method === 'Page.javascriptDialogClosed') {
      this._recordDialogEvent(tabId);
      this.dialogsByTab.delete(tabId);
      return;
    }
    if (method !== 'Page.javascriptDialogOpening' || !params || typeof params !== 'object') {
      return;
    }
    const event = /** @type {Record<string, unknown>} */ (params);
    const type = normalizeDialogType(event.type);
    const message = boundDialogText(event.message);
    const defaultPrompt = boundDialogText(event.defaultPrompt);
    if (!this.dialogsByTab.has(tabId) && this.dialogsByTab.size >= MAX_TRACKED_DIALOGS) {
      const oldestTabId = this.dialogsByTab.keys().next().value;
      if (typeof oldestTabId === 'number') this.dialogsByTab.delete(oldestTabId);
    }
    this.dialogsByTab.delete(tabId);
    const dialog = {
      dialogId: this._nextDialogId(),
      type,
      message: message.value,
      defaultPrompt: defaultPrompt.value,
      messageTruncated: message.truncated,
      defaultPromptTruncated: defaultPrompt.truncated,
      openedAt: Date.now(),
    };
    this._recordDialogEvent(tabId, dialog.dialogId);
    this.dialogsByTab.set(tabId, dialog);
    this._settleDialogWaiters(tabId, dialog);
  }

  /**
   * @param {number} tabId
   * @returns {TrackedDialog | null}
   */
  getDialog(tabId) {
    return this.dialogsByTab.get(tabId) ?? null;
  }

  /**
   * Return non-text event ordering used to detect replacement dialogs around a
   * CDP command. The observation does not make the CDP action identity-bound.
   *
   * @param {number} tabId
   * @returns {{ dialog: TrackedDialog | null, eventSequence: number, lastOpenedDialogId: string | null }}
   */
  getDialogObservation(tabId) {
    const events = this.dialogEventsByTab.get(tabId);
    return {
      dialog: this.dialogsByTab.get(tabId) ?? null,
      eventSequence: events?.eventSequence ?? 0,
      lastOpenedDialogId: events?.lastOpenedDialogId ?? null,
    };
  }

  /**
   * Wait briefly for an opening event that may arrive just after Page.enable.
   * This only observes state; callers must still identity-check before acting.
   *
   * @param {number} tabId
   * @param {number} [timeoutMs]
   * @returns {Promise<TrackedDialog | null>}
   */
  waitForDialog(tabId, timeoutMs = 250) {
    const current = this.dialogsByTab.get(tabId);
    if (current) return Promise.resolve(current);
    return new Promise((resolve) => {
      /** @type {DialogWaiter} */
      const waiter = {
        timeoutId: setTimeout(
          () => {
            const waiters = this.dialogWaitersByTab.get(tabId);
            waiters?.delete(waiter);
            if (waiters?.size === 0) this.dialogWaitersByTab.delete(tabId);
            resolve(null);
          },
          Math.max(0, Math.min(timeoutMs, 1_000))
        ),
        resolve,
      };
      waiter.timeoutId.unref?.();
      const waiters = this.dialogWaitersByTab.get(tabId) ?? new Set();
      waiters.add(waiter);
      this.dialogWaitersByTab.set(tabId, waiters);

      // Close a read/subscribe race if an event arrived while registering.
      const observed = this.dialogsByTab.get(tabId);
      if (observed) this._settleDialogWaiters(tabId, observed);
    });
  }

  /**
   * Return non-sensitive status suitable for page.get_state.
   *
   * @param {number} tabId
   * @returns {{ status: 'open' | 'none' | 'unknown', observable: boolean, type?: TrackedDialog['type'], openedAt?: number }}
   */
  getDialogStatus(tabId) {
    const dialog = this.dialogsByTab.get(tabId);
    if (dialog) {
      return {
        status: 'open',
        observable: true,
        type: dialog.type,
        openedAt: dialog.openedAt,
      };
    }
    return this.attachedTabs.has(tabId)
      ? { status: 'none', observable: true }
      : { status: 'unknown', observable: false };
  }

  /**
   * @param {number} tabId
   * @param {string} dialogId
   * @returns {boolean}
   */
  clearDialog(tabId, dialogId) {
    if (this.dialogsByTab.get(tabId)?.dialogId !== dialogId) return false;
    return this.dialogsByTab.delete(tabId);
  }

  /**
   * Clear all dialog knowledge without changing unrelated debugger state.
   *
   * @param {number} tabId
   * @returns {void}
   */
  clearDialogState(tabId) {
    this.dialogsByTab.delete(tabId);
    this.dialogEventsByTab.delete(tabId);
    this._settleDialogWaiters(tabId, null);
  }

  /**
   * Drop all coordinator state and detach one tab during tab/window/access
   * cleanup. Fetch holds should be released first, but this is intentionally
   * safe if Chrome already detached the target.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async discard(tabId) {
    await this.runExclusive(tabId, async () => {
      const timer = this.burstTimers.get(tabId);
      if (timer) clearTimeout(timer);
      this.burstTimers.delete(tabId);
      this.holdsByTab.delete(tabId);
      this.clearDialogState(tabId);
      if (!this.attachedTabs.delete(tabId)) return;
      await this.detach({ tabId }).catch(() => {});
    });
  }

  /**
   * @param {DebuggerTarget} target
   * @returns {Promise<void>}
   */
  async _attach(target) {
    await this.attach(target, this.protocolVersion);
    this.attachedTabs.add(target.tabId);
    try {
      await this.initialize(target);
    } catch (error) {
      this.markDetached(target.tabId);
      await this.detach(target).catch(() => {});
      throw error;
    }
  }

  /** @returns {string} */
  _nextDialogId() {
    this.nextDialogGeneration =
      this.nextDialogGeneration >= Number.MAX_SAFE_INTEGER ? 1 : this.nextDialogGeneration + 1;
    return `${this.dialogIdentityPrefix}:${this.nextDialogGeneration}`;
  }

  /**
   * @param {number} tabId
   * @param {string} [openedDialogId]
   * @returns {void}
   */
  _recordDialogEvent(tabId, openedDialogId) {
    if (!this.dialogEventsByTab.has(tabId) && this.dialogEventsByTab.size >= MAX_TRACKED_DIALOGS) {
      const oldestTabId = this.dialogEventsByTab.keys().next().value;
      if (typeof oldestTabId === 'number') this.dialogEventsByTab.delete(oldestTabId);
    }
    const current = this.dialogEventsByTab.get(tabId);
    this.dialogEventsByTab.delete(tabId);
    this.dialogEventsByTab.set(tabId, {
      eventSequence: (current?.eventSequence ?? 0) + 1,
      lastOpenedDialogId: openedDialogId ?? current?.lastOpenedDialogId ?? null,
    });
  }

  /**
   * @param {number} tabId
   * @param {TrackedDialog | null} dialog
   * @returns {void}
   */
  _settleDialogWaiters(tabId, dialog) {
    const waiters = this.dialogWaitersByTab.get(tabId);
    if (!waiters) return;
    this.dialogWaitersByTab.delete(tabId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeoutId);
      waiter.resolve(dialog);
    }
  }

  /**
   * Reset or start the burst idle timer for a tab. When it fires, detach
   * the debugger if no explicit hold is active.
   *
   * @param {number} tabId
   * @param {DebuggerTarget} target
   * @returns {void}
   */
  _resetBurstTimer(tabId, target) {
    const existing = this.burstTimers.get(tabId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      await this.runExclusive(tabId, async () => {
        if (this.burstTimers.get(tabId) !== timer) return;
        this.burstTimers.delete(tabId);
        if ((this.holdsByTab.get(tabId) ?? 0) > 0) return;
        try {
          await this.detach(target);
        } catch {
          // Already detached or tab closed.
        } finally {
          this.markDetached(tabId);
        }
      });
    }, this.burstIdleMs);
    timer.unref?.();
    this.burstTimers.set(tabId, timer);
  }

  /**
   * Clear a pending burst-idle detach before starting new debugger work.
   *
   * @param {number} tabId
   * @returns {boolean}
   */
  _consumeBurstTimer(tabId) {
    const existing = this.burstTimers.get(tabId);
    if (!existing) return false;
    clearTimeout(existing);
    this.burstTimers.delete(tabId);
    return true;
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
        const hasBurst = this._consumeBurstTimer(tabId);
        let attached = false;
        try {
          if (!hasBurst) {
            await this._attach(target);
            attached = true;
          }
          await initialize(target);
        } catch (error) {
          if (attached) {
            await this.detach(target).catch(() => {});
            this.markDetached(tabId);
          } else if (hasBurst) {
            this._resetBurstTimer(tabId, target);
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
      try {
        await this.detach(target);
      } finally {
        this.markDetached(tabId);
      }
      if (cleanupError) {
        throw cleanupError;
      }
    });
  }
}

/**
 * @param {unknown} value
 * @returns {TrackedDialog['type']}
 */
function normalizeDialogType(value) {
  return value === 'confirm' || value === 'prompt' || value === 'beforeunload' ? value : 'alert';
}

/**
 * @param {unknown} value
 * @returns {{ value: string, truncated: boolean }}
 */
function boundDialogText(value) {
  const text = typeof value === 'string' ? value : '';
  return text.length <= MAX_DIALOG_TEXT_LENGTH
    ? { value: text, truncated: false }
    : { value: text.slice(0, MAX_DIALOG_TEXT_LENGTH), truncated: true };
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isDebuggerDetachedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not attached|no target with given id/i.test(message);
}
