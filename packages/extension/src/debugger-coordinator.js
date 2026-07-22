// @ts-check

/** @typedef {{ tabId: number }} DebuggerTarget */
/** @typedef {(target: DebuggerTarget, protocolVersion: string) => Promise<void>} DebuggerAttach */
/** @typedef {(target: DebuggerTarget) => Promise<void>} DebuggerDetach */
/** @typedef {(target: DebuggerTarget) => Promise<void>} DebuggerInitialize */

const MAX_TRACKED_DIALOGS = 100;
const MAX_DIALOG_TEXT_LENGTH = 4_096;
const RECENT_DEBUGGER_REASON_TTL_MS = 5 * 60 * 1000;
const MAX_DIAGNOSTIC_COUNT = 10_000;

/** @typedef {'debugger_conflict' | 'debugger_detached' | 'debugger_replaced' | 'debugger_canceled' | 'target_closed'} DebuggerReason */

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

/** @typedef {{ count: number, discardPromise: Promise<void> | null }} CleanupBarrier */

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
    /** @type {Map<number, Promise<void>>} */
    this.pendingDialogsByTab = new Map();
    /** @type {Map<number, number>} */
    this.dialogOwnersByTab = new Map();
    /** @type {Map<number, number>} */
    this.cancellationGenerationsByTab = new Map();
    /** @type {Map<number, Map<number, number>>} */
    this.inFlightTasksByTab = new Map();
    /** @type {Map<number, CleanupBarrier>} */
    this.cleanupBarriersByTab = new Map();
    /** @type {Map<number, Promise<void>>} */
    this.attachingByTab = new Map();
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
    /** @type {{ reason: DebuggerReason, at: number } | null} */
    this.recentReason = null;
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
    const generation = this._getCancellationGeneration(tabId);
    this._assertCanStartWork(tabId, generation);
    return this.runExclusive(tabId, async () => {
      await this._waitForDialogLane(tabId);
      this._assertCancellationGeneration(tabId, generation);
      const target = { tabId };
      const held = (this.holdsByTab.get(tabId) ?? 0) > 0;
      const hasBurst = this._consumeBurstTimer(tabId);
      const alreadyAttached = this.attachedTabs.has(tabId);
      /** @type {T | undefined} */
      let result;
      /** @type {unknown} */
      let taskError = null;
      let detached = false;

      try {
        if (!held && !hasBurst && !alreadyAttached) {
          await this._attach(target, generation);
        }
        result = await this._runTrackedTask(tabId, generation, () => task(target));
        await this._waitForDialogLane(tabId);
        this._assertCancellationGeneration(tabId, generation);
      } catch (error) {
        if (!this._isCancellationGenerationCurrent(tabId, generation)) {
          taskError = createDebuggerCanceledError();
          detached = true;
        } else if (isDebuggerDetachedError(error)) {
          this.markDetached(tabId, 'debugger_detached');
          detached = true;
          if (options.retryDetached === false) {
            taskError = error;
          } else {
            try {
              await this._attach(target, generation);
              detached = false;
              result = await this._runTrackedTask(tabId, generation, () => task(target));
              await this._waitForDialogLane(tabId);
              this._assertCancellationGeneration(tabId, generation);
            } catch (retryError) {
              taskError = this._isCancellationGenerationCurrent(tabId, generation)
                ? retryError
                : createDebuggerCanceledError();
            }
          }
        } else {
          taskError = error;
        }
      }

      // Schedule a burst-idle detach instead of detaching immediately.
      if (
        (this.holdsByTab.get(tabId) ?? 0) === 0 &&
        !detached &&
        this._isCancellationGenerationCurrent(tabId, generation) &&
        this.attachedTabs.has(tabId)
      ) {
        this._resetBurstTimer(tabId, target);
      }

      if (taskError) {
        throw taskError;
      }
      return /** @type {T} */ (result);
    });
  }

  /**
   * Handle an already observed dialog without waiting behind the debugger task
   * that may be blocked by that dialog. An attached tab with pending normal
   * work also takes this lane so a just-arriving opening event can be observed.
   * Otherwise attachment and Page initialization stay on the normal path.
   *
   * @template T
   * @param {number} tabId
   * @param {(target: DebuggerTarget) => Promise<T>} task
   * @param {{ retryDetached?: boolean }} [options]
   * @returns {Promise<T>}
   */
  async runForDialog(tabId, task, options = {}) {
    const generation = this._getCancellationGeneration(tabId);
    this._assertCanStartWork(tabId, generation);
    if (
      !this.attachedTabs.has(tabId) ||
      (!this.dialogsByTab.has(tabId) && !this.pendingByTab.has(tabId))
    ) {
      return this.run(tabId, task, options);
    }

    const previous = this.pendingDialogsByTab.get(tabId) ?? Promise.resolve();
    /** @type {(value?: void | PromiseLike<void>) => void} */
    let releaseTurn = () => {};
    const turn = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    const queuedTurn = previous.catch(() => {}).then(() => turn);
    this.pendingDialogsByTab.set(tabId, queuedTurn);

    await previous.catch(() => {});
    const target = { tabId };
    let hadBurst = false;
    let ownsSession = false;
    try {
      this._assertCancellationGeneration(tabId, generation);
      if (!this.attachedTabs.has(tabId)) throw createDebuggerCanceledError();
      hadBurst = this._consumeBurstTimer(tabId);
      this.dialogOwnersByTab.set(tabId, generation);
      ownsSession = true;
      const result = await this._runTrackedTask(tabId, generation, () => task(target));
      this._assertCancellationGeneration(tabId, generation);
      return result;
    } catch (error) {
      if (!this._isCancellationGenerationCurrent(tabId, generation)) {
        throw createDebuggerCanceledError();
      }
      if (isDebuggerDetachedError(error)) {
        this.markDetached(tabId, 'debugger_detached');
      }
      // An out-of-band dialog mutation must never be replayed.
      throw error;
    } finally {
      if (ownsSession && this.dialogOwnersByTab.get(tabId) === generation) {
        this.dialogOwnersByTab.delete(tabId);
      }
      if (
        hadBurst &&
        this._isCancellationGenerationCurrent(tabId, generation) &&
        this.attachedTabs.has(tabId) &&
        (this.holdsByTab.get(tabId) ?? 0) === 0 &&
        !this.pendingByTab.has(tabId)
      ) {
        this._resetBurstTimer(tabId, target);
      }
      releaseTurn();
      if (this.pendingDialogsByTab.get(tabId) === queuedTurn) {
        this.pendingDialogsByTab.delete(tabId);
      }
    }
  }

  /**
   * Forget a debugger session that Chrome detached outside this coordinator.
   *
   * @param {number} tabId
   * @param {DebuggerReason | null} [reason]
   * @returns {void}
   */
  markDetached(tabId, reason = null) {
    const existing = this.burstTimers.get(tabId);
    if (existing) clearTimeout(existing);
    this.burstTimers.delete(tabId);
    this.holdsByTab.delete(tabId);
    this.dialogOwnersByTab.delete(tabId);
    this.attachedTabs.delete(tabId);
    this.clearDialogState(tabId);
    if (reason) {
      this.recentReason = { reason, at: Date.now() };
    }
  }

  /**
   * Record Chrome's non-sensitive debugger detach category.
   *
   * @param {number} tabId
   * @param {unknown} reason
   * @returns {void}
   */
  handleDetach(tabId, reason) {
    this.markDetached(tabId, normalizeDetachReason(reason));
  }

  /**
   * Return bounded, non-sensitive runtime state for health diagnostics.
   *
   * @param {number} [now]
   * @returns {{ status: 'idle' | 'active', attachedTabCount: number, heldTabCount: number, pendingTabCount: number, recentReason: DebuggerReason | null }}
   */
  getDiagnostics(now = Date.now()) {
    const recentReason =
      this.recentReason && now - this.recentReason.at <= RECENT_DEBUGGER_REASON_TTL_MS
        ? this.recentReason.reason
        : null;
    return {
      status: this.attachedTabs.size > 0 ? 'active' : 'idle',
      attachedTabCount: Math.min(this.attachedTabs.size, MAX_DIAGNOSTIC_COUNT),
      heldTabCount: Math.min(this.holdsByTab.size, MAX_DIAGNOSTIC_COUNT),
      pendingTabCount: Math.min(this.pendingByTab.size, MAX_DIAGNOSTIC_COUNT),
      recentReason,
    };
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
   * cleanup without waiting behind a debugger command blocked by a dialog.
   * This is intentionally safe if Chrome already detached the target.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async discard(tabId) {
    this.cancellationGenerationsByTab.set(tabId, this._getCancellationGeneration(tabId) + 1);
    const timer = this.burstTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.burstTimers.delete(tabId);
    this.holdsByTab.delete(tabId);
    this.dialogOwnersByTab.delete(tabId);
    this.clearDialogState(tabId);

    const wasAttached = this.attachedTabs.delete(tabId);
    const attaching = this.attachingByTab.get(tabId);
    if (wasAttached) {
      await this.detach({ tabId }).catch(() => {});
    } else if (attaching) {
      const attached = await attaching.then(
        () => true,
        () => false
      );
      if (attached) await this.detach({ tabId }).catch(() => {});
    }
  }

  /**
   * Keep new debugger ownership out until a complete tab cleanup sequence has
   * discarded the session and reconciled its domain-specific owners.
   *
   * @param {number} tabId
   * @returns {Promise<() => void>}
   */
  async beginCleanup(tabId) {
    let barrier = this.cleanupBarriersByTab.get(tabId);
    if (!barrier) {
      barrier = { count: 0, discardPromise: null };
      this.cleanupBarriersByTab.set(tabId, barrier);
    }
    barrier.count += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      barrier.count -= 1;
      if (barrier.count === 0 && this.cleanupBarriersByTab.get(tabId) === barrier) {
        this.cleanupBarriersByTab.delete(tabId);
      }
    };
    return release;
  }

  /** @param {number} tabId @returns {Promise<void>} */
  async commitCleanup(tabId) {
    const barrier = this.cleanupBarriersByTab.get(tabId);
    if (!barrier) {
      await this.discard(tabId);
      return;
    }
    barrier.discardPromise ??= this.discard(tabId);
    await barrier.discardPromise;
  }

  /** @param {number} tabId @returns {void} */
  assertCanStart(tabId) {
    this._assertCanStartWork(tabId, this._getCancellationGeneration(tabId));
  }

  /**
   * @param {DebuggerTarget} target
   * @returns {Promise<void>}
   */
  async _attach(target, generation = this._getCancellationGeneration(target.tabId)) {
    const attaching = this.attach(target, this.protocolVersion);
    this.attachingByTab.set(target.tabId, attaching);
    try {
      await attaching;
    } catch (error) {
      const reason = classifyDebuggerFailure(error);
      if (reason) {
        this.recentReason = { reason, at: Date.now() };
      }
      throw error;
    } finally {
      if (this.attachingByTab.get(target.tabId) === attaching) {
        this.attachingByTab.delete(target.tabId);
      }
    }
    if (!this._isCancellationGenerationCurrent(target.tabId, generation)) {
      throw createDebuggerCanceledError();
    }
    this.attachedTabs.add(target.tabId);
    try {
      await this._runTrackedTask(target.tabId, generation, () => this.initialize(target));
      await this._waitForDialogLane(target.tabId);
      this._assertCancellationGeneration(target.tabId, generation);
    } catch (error) {
      if (!this._isCancellationGenerationCurrent(target.tabId, generation)) {
        this.attachedTabs.delete(target.tabId);
        throw createDebuggerCanceledError();
      }
      this.markDetached(target.tabId, classifyDebuggerFailure(error));
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
    const generation = this._getCancellationGeneration(tabId);
    const timer = setTimeout(async () => {
      await this.runExclusive(tabId, async () => {
        await this._waitForDialogLane(tabId);
        if (this.burstTimers.get(tabId) !== timer) return;
        this.burstTimers.delete(tabId);
        if (!this._isCancellationGenerationCurrent(tabId, generation)) return;
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
   * Wait for all dialog turns that were authorized ahead of this normal turn.
   * Dialog turns never wait on the normal queue, so this cannot form a cycle.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async _waitForDialogLane(tabId) {
    let pending = this.pendingDialogsByTab.get(tabId);
    while (pending) {
      await pending.catch(() => {});
      const next = this.pendingDialogsByTab.get(tabId);
      if (!next || next === pending) return;
      pending = next;
    }
  }

  /** @param {number} tabId @returns {number} */
  _getCancellationGeneration(tabId) {
    return this.cancellationGenerationsByTab.get(tabId) ?? 0;
  }

  /** @param {number} tabId @param {number} generation @returns {boolean} */
  _isCancellationGenerationCurrent(tabId, generation) {
    return this._getCancellationGeneration(tabId) === generation;
  }

  /** @param {number} tabId @param {number} generation @returns {void} */
  _assertCancellationGeneration(tabId, generation) {
    if (!this._isCancellationGenerationCurrent(tabId, generation)) {
      throw createDebuggerCanceledError();
    }
  }

  /** @param {number} tabId @param {number} generation @returns {void} */
  _assertCanStartWork(tabId, generation) {
    if (this.cleanupBarriersByTab.has(tabId)) throw createDebuggerCanceledError();
    const generations = this.inFlightTasksByTab.get(tabId);
    for (const [taskGeneration, count] of generations ?? []) {
      if (taskGeneration !== generation && count > 0) throw createDebuggerCanceledError();
    }
  }

  /**
   * Keep the underlying multi-command task tied to its physical debugger
   * generation until it really settles. Cleanup may detach it, but a fresh
   * session cannot start while stale code could still issue another command.
   *
   * @template T
   * @param {number} tabId
   * @param {number} generation
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  async _runTrackedTask(tabId, generation, task) {
    const generations = this.inFlightTasksByTab.get(tabId) ?? new Map();
    generations.set(generation, (generations.get(generation) ?? 0) + 1);
    this.inFlightTasksByTab.set(tabId, generations);
    try {
      return await task();
    } finally {
      const remaining = (generations.get(generation) ?? 1) - 1;
      if (remaining > 0) generations.set(generation, remaining);
      else generations.delete(generation);
      if (generations.size === 0 && this.inFlightTasksByTab.get(tabId) === generations) {
        this.inFlightTasksByTab.delete(tabId);
      }
    }
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
    const generation = this._getCancellationGeneration(tabId);
    this._assertCanStartWork(tabId, generation);
    await this.runExclusive(tabId, async () => {
      await this._waitForDialogLane(tabId);
      this._assertCancellationGeneration(tabId, generation);
      const target = { tabId };
      const holdCount = this.holdsByTab.get(tabId) ?? 0;
      if (holdCount === 0) {
        const hasBurst = this._consumeBurstTimer(tabId);
        const alreadyAttached = this.attachedTabs.has(tabId);
        let attached = false;
        try {
          if (!hasBurst && !alreadyAttached) {
            await this._attach(target, generation);
            attached = true;
          }
          await this._runTrackedTask(tabId, generation, () => initialize(target));
          await this._waitForDialogLane(tabId);
          this._assertCancellationGeneration(tabId, generation);
        } catch (error) {
          if (!this._isCancellationGenerationCurrent(tabId, generation)) {
            throw createDebuggerCanceledError();
          }
          if (attached && this._isCancellationGenerationCurrent(tabId, generation)) {
            await this.detach(target).catch(() => {});
            this.markDetached(tabId);
          } else if (
            this.attachedTabs.has(tabId) &&
            this._isCancellationGenerationCurrent(tabId, generation)
          ) {
            this._resetBurstTimer(tabId, target);
          }
          throw error;
        }
      }
      this._assertCancellationGeneration(tabId, generation);
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
    if ((this.holdsByTab.get(tabId) ?? 0) === 0 && !this.attachedTabs.has(tabId)) return;
    const generation = this._getCancellationGeneration(tabId);
    await this.runExclusive(tabId, async () => {
      await this._waitForDialogLane(tabId);
      this._assertCancellationGeneration(tabId, generation);
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
        await this._runTrackedTask(tabId, generation, () => cleanup(target));
      } catch (error) {
        cleanupError = error;
      }
      await this._waitForDialogLane(tabId);
      this._assertCancellationGeneration(tabId, generation);
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

/** @returns {Error} */
function createDebuggerCanceledError() {
  return new Error('Debugger operation canceled because tab access was cleared.');
}

/**
 * @param {unknown} error
 * @returns {DebuggerReason | null}
 */
export function classifyDebuggerFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/another debugger|debugger.{0,40}(?:already attached|conflict|in use)/iu.test(message)) {
    return 'debugger_conflict';
  }
  if (/not attached|no target with given id|debugger.{0,40}detach/iu.test(message)) {
    return 'debugger_detached';
  }
  return null;
}

/**
 * @param {unknown} reason
 * @returns {DebuggerReason}
 */
function normalizeDetachReason(reason) {
  if (reason === 'replaced_with_devtools') return 'debugger_replaced';
  if (reason === 'canceled_by_user') return 'debugger_canceled';
  if (reason === 'target_closed') return 'target_closed';
  return 'debugger_detached';
}
