import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';

export type DebuggerTarget = { tabId: number };
export type DebuggerAttach = (target: DebuggerTarget, protocolVersion: string) => Promise<void>;
export type DebuggerDetach = (target: DebuggerTarget) => Promise<void>;
export type DebuggerInitialize = (target: DebuggerTarget) => Promise<void>;
export type DebuggerRunOptions = { retryDetached?: boolean; releaseAfterRun?: boolean };

const MAX_TRACKED_DIALOGS = 100;
const MAX_DIALOG_TEXT_LENGTH = 4_096;
const RECENT_DEBUGGER_REASON_TTL_MS = 5 * 60 * 1000;
const MAX_DIAGNOSTIC_COUNT = 10_000;

export type DebuggerReason =
  | 'debugger_conflict'
  | 'debugger_detached'
  | 'debugger_replaced'
  | 'debugger_canceled'
  | 'target_closed';

export type TrackedDialog = {
  dialogId: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt: string;
  messageTruncated: boolean;
  defaultPromptTruncated: boolean;
  openedAt: number;
};

export type DialogWaiter = {
  timeoutId: ReturnType<typeof setTimeout>;
  resolve: (dialog: TrackedDialog | null) => void;
};

export type DialogEventState = {
  eventSequence: number;
  lastOpenedDialogId: string | null;
};

export type CleanupBarrier = { count: number; discardPromise: Promise<void> | null };

/**
 * Serialize Chrome debugger sessions per tab so concurrent bridge requests do
 * not race on `chrome.debugger.attach`.
 */
export class TabDebuggerCoordinator {
  declare attach: DebuggerAttach;
  declare detach: DebuggerDetach;
  declare initialize: DebuggerInitialize;
  declare protocolVersion: string;
  declare burstIdleMs: number;
  declare recordReattach: (outcome: 'success' | 'failure') => void;
  declare pendingByTab: Map<number, Promise<void>>;
  declare pendingDialogsByTab: Map<number, Promise<void>>;
  declare dialogOwnersByTab: Map<number, number>;
  declare cancellationGenerationsByTab: Map<number, number>;
  declare inFlightTasksByTab: Map<number, Map<number, number>>;
  declare cleanupBarriersByTab: Map<number, CleanupBarrier>;
  declare attachingByTab: Map<number, Promise<void>>;
  declare holdsByTab: Map<number, number>;
  declare burstTimers: Map<number, ReturnType<typeof setTimeout>>;
  declare attachedTabs: Set<number>;
  declare burstRetainedTabs: Set<number>;
  declare dialogsByTab: Map<number, TrackedDialog>;
  declare dialogWaitersByTab: Map<number, Set<DialogWaiter>>;
  declare dialogEventsByTab: Map<number, DialogEventState>;
  declare dialogGuardsByTab: Map<number, Set<(dialog: TrackedDialog) => void>>;
  declare taskGuards: WeakMap<DebuggerTarget, () => void>;
  declare dialogIdentityPrefix: string;
  declare nextDialogGeneration: number;
  declare recentReason: { reason: DebuggerReason; at: number } | null;

  constructor({
    attach,
    detach,
    initialize = async () => {},
    protocolVersion = '1.3',
    burstIdleMs = 5_000,
    recordReattach = () => {},
  }: {
    attach: DebuggerAttach;
    detach: DebuggerDetach;
    initialize?: DebuggerInitialize;
    protocolVersion?: string;
    burstIdleMs?: number;
    recordReattach?: (outcome: 'success' | 'failure') => void;
  }) {
    this.attach = attach;
    this.detach = detach;
    this.initialize = initialize;
    this.protocolVersion = protocolVersion;
    this.burstIdleMs = burstIdleMs;
    this.recordReattach = recordReattach;

    this.pendingByTab = new Map();

    this.pendingDialogsByTab = new Map();

    this.dialogOwnersByTab = new Map();

    this.cancellationGenerationsByTab = new Map();

    this.inFlightTasksByTab = new Map();

    this.cleanupBarriersByTab = new Map();

    this.attachingByTab = new Map();

    this.holdsByTab = new Map();

    this.burstTimers = new Map();

    this.attachedTabs = new Set();

    this.burstRetainedTabs = new Set();

    this.dialogsByTab = new Map();

    this.dialogWaitersByTab = new Map();

    this.dialogEventsByTab = new Map();

    this.dialogGuardsByTab = new Map();

    this.taskGuards = new WeakMap();
    this.dialogIdentityPrefix = globalThis.crypto.randomUUID();
    this.nextDialogGeneration = 0;

    this.recentReason = null;
  }

  /** Run one serialized operation for a tab. */
  async runExclusive<T>(tabId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.pendingByTab.get(tabId) ?? Promise.resolve();

    let releaseTurn: (value?: void | PromiseLike<void>) => void = (): void => {};
    const turn = new Promise<void>((resolve) => {
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

  /** Run one debugger-backed task for a tab once earlier tasks for that tab
have finished. */
  async run<T>(
    tabId: number,
    task: (target: DebuggerTarget) => Promise<T>,
    options: DebuggerRunOptions = {}
  ): Promise<T> {
    const generation = this._getCancellationGeneration(tabId);
    this._assertCanStartWork(tabId, generation);
    return this.runExclusive(tabId, async () => {
      await this._waitForDialogLane(tabId);
      this._assertCancellationGeneration(tabId, generation);
      const target = { tabId };
      const held = (this.holdsByTab.get(tabId) ?? 0) > 0;
      const hasBurst = this._consumeBurstTimer(tabId);
      const alreadyAttached = this.attachedTabs.has(tabId);

      let result: T | undefined;

      let taskError: unknown = null;
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
          if (options.retryDetached === true) {
            try {
              try {
                await this._attach(target, generation);
                this.recordReattach('success');
              } catch (attachError) {
                this.recordReattach('failure');
                throw attachError;
              }
              detached = false;
              result = await this._runTrackedTask(tabId, generation, () => task(target));
              await this._waitForDialogLane(tabId);
              this._assertCancellationGeneration(tabId, generation);
            } catch (retryError) {
              taskError = this._isCancellationGenerationCurrent(tabId, generation)
                ? retryError
                : createDebuggerCanceledError();
            }
          } else {
            taskError = error;
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
        this._resetBurstTimer(
          tabId,
          target,
          options.releaseAfterRun !== true || this.dialogsByTab.has(tabId)
        );
      }

      if (taskError) {
        throw taskError;
      }
      return result as T;
    });
  }

  /** Return control when a native dialog blocks an action. The original task
stays on the normal queue until it really settles; it is never replayed.
Dialog handling uses its separate lane to unblock that task. */
  async runGuarded<T>(tabId: number, task: (target: DebuggerTarget) => Promise<T>): Promise<T> {
    this.assertNoDialog(tabId);
    let started = false;

    let interrupted: BridgeError | null = null;

    let onDialog: (dialog: TrackedDialog) => void = (): void => {};

    const blocked: Promise<never> = new Promise((resolve, reject) => {
      onDialog = (dialog) => {
        interrupted = createDialogBlockedError(tabId, dialog, started);
        reject(interrupted);
      };
    });
    const guards = this.dialogGuardsByTab.get(tabId) ?? new Set();
    guards.add(onDialog);
    this.dialogGuardsByTab.set(tabId, guards);
    const operation = this.run(tabId, async (target) => {
      const generation = this._getCancellationGeneration(tabId);
      const assertActive = () => {
        this._assertCancellationGeneration(tabId, generation);
        if (interrupted) throw interrupted;
        this.assertNoDialog(tabId);
      };
      assertActive();
      this.taskGuards.set(target, assertActive);
      started = true;
      try {
        return await task(target);
      } finally {
        this.taskGuards.delete(target);
      }
    });
    try {
      return await Promise.race([operation, blocked]);
    } finally {
      guards.delete(onDialog);
      if (guards.size === 0 && this.dialogGuardsByTab.get(tabId) === guards) {
        this.dialogGuardsByTab.delete(tabId);
      }
    }
  }

  assertNoDialog(tabId: number): void {
    const dialog = this.dialogsByTab.get(tabId);
    if (dialog) throw createDialogBlockedError(tabId, dialog, false);
  }

  /** Prevent a native multi-command action from issuing its remaining commands
after an interrupted command resumes, even if the dialog has since closed. */
  assertTaskActive(target: DebuggerTarget): void {
    this.taskGuards.get(target)?.();
  }

  /** Handle an already observed dialog without waiting behind the debugger task
that may be blocked by that dialog. An attached tab with pending normal
work also takes this lane so a just-arriving opening event can be observed.
Otherwise attachment and Page initialization stay on the normal path. */
  async runForDialog<T>(
    tabId: number,
    task: (target: DebuggerTarget) => Promise<T>,
    options: { retryDetached?: boolean } = {}
  ): Promise<T> {
    const generation = this._getCancellationGeneration(tabId);
    this._assertCanStartWork(tabId, generation);
    if (
      !this.attachedTabs.has(tabId) ||
      (!this.dialogsByTab.has(tabId) && !this.pendingByTab.has(tabId))
    ) {
      return this.run(tabId, task, options);
    }

    const previous = this.pendingDialogsByTab.get(tabId) ?? Promise.resolve();

    let releaseTurn: (value?: void | PromiseLike<void>) => void = (): void => {};
    const turn = new Promise<void>((resolve) => {
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

  /** Forget a debugger session that Chrome detached outside this coordinator. */
  markDetached(tabId: number, reason: DebuggerReason | null = null): void {
    const existing = this.burstTimers.get(tabId);
    if (existing) clearTimeout(existing);
    this.burstTimers.delete(tabId);
    this.holdsByTab.delete(tabId);
    this.dialogOwnersByTab.delete(tabId);
    this.attachedTabs.delete(tabId);
    this.burstRetainedTabs.delete(tabId);
    this.clearDialogState(tabId);
    if (reason) {
      this.recentReason = { reason, at: Date.now() };
    }
  }

  /** Record Chrome's non-sensitive debugger detach category. */
  handleDetach(tabId: number, reason: unknown): void {
    this.markDetached(tabId, normalizeDetachReason(reason));
  }

  /** Return bounded, non-sensitive runtime state for health diagnostics. */
  getDiagnostics(now: number = Date.now()): {
    status: 'idle' | 'active';
    attachedTabCount: number;
    heldTabCount: number;
    pendingTabCount: number;
    recentReason: DebuggerReason | null;
  } {
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

  /** Track Page-domain dialog events without exposing their text through logs or
page-state summaries. Only events observed while the debugger is attached
are knowable; detachment clears that knowledge. */
  handleEvent(tabId: number, method: string, params: unknown): void {
    if (method === 'Page.javascriptDialogClosed') {
      this._recordDialogEvent(tabId);
      this.dialogsByTab.delete(tabId);
      return;
    }
    if (method !== 'Page.javascriptDialogOpening' || !params || typeof params !== 'object') {
      return;
    }
    const event = params as Record<string, unknown>;
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
    for (const guard of this.dialogGuardsByTab.get(tabId) ?? []) guard(dialog);
  }

  getDialog(tabId: number): TrackedDialog | null {
    return this.dialogsByTab.get(tabId) ?? null;
  }

  /** Return non-text event ordering used to detect replacement dialogs around a
CDP command. The observation does not make the CDP action identity-bound. */
  getDialogObservation(tabId: number): {
    dialog: TrackedDialog | null;
    eventSequence: number;
    lastOpenedDialogId: string | null;
  } {
    const events = this.dialogEventsByTab.get(tabId);
    return {
      dialog: this.dialogsByTab.get(tabId) ?? null,
      eventSequence: events?.eventSequence ?? 0,
      lastOpenedDialogId: events?.lastOpenedDialogId ?? null,
    };
  }

  /** Wait briefly for an opening event that may arrive just after Page.enable.
This only observes state; callers must still identity-check before acting. */
  waitForDialog(tabId: number, timeoutMs: number = 250): Promise<TrackedDialog | null> {
    const current = this.dialogsByTab.get(tabId);
    if (current) return Promise.resolve(current);
    return new Promise((resolve) => {
      const waiter: DialogWaiter = {
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
      const waiters = this.dialogWaitersByTab.get(tabId) ?? new Set();
      waiters.add(waiter);
      this.dialogWaitersByTab.set(tabId, waiters);

      // Close a read/subscribe race if an event arrived while registering.
      const observed = this.dialogsByTab.get(tabId);
      if (observed) this._settleDialogWaiters(tabId, observed);
    });
  }

  /** Return non-sensitive status suitable for page.get_state. */
  getDialogStatus(tabId: number): {
    status: 'open' | 'none' | 'unknown';
    observable: boolean;
    type?: TrackedDialog['type'];
    openedAt?: number;
  } {
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

  clearDialog(tabId: number, dialogId: string): boolean {
    if (this.dialogsByTab.get(tabId)?.dialogId !== dialogId) return false;
    return this.dialogsByTab.delete(tabId);
  }

  /** Clear all dialog knowledge without changing unrelated debugger state. */
  clearDialogState(tabId: number): void {
    this.dialogsByTab.delete(tabId);
    this.dialogEventsByTab.delete(tabId);
    this._settleDialogWaiters(tabId, null);
  }

  /** Drop all coordinator state and detach one tab during tab/window/access
cleanup without waiting behind a debugger command blocked by a dialog.
This is intentionally safe if Chrome already detached the target. */
  async discard(tabId: number): Promise<void> {
    this.cancellationGenerationsByTab.set(tabId, this._getCancellationGeneration(tabId) + 1);
    const timer = this.burstTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.burstTimers.delete(tabId);
    this.holdsByTab.delete(tabId);
    this.burstRetainedTabs.delete(tabId);
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

  /** Keep new debugger ownership out until a complete tab cleanup sequence has
discarded the session and reconciled its domain-specific owners. */
  async beginCleanup(tabId: number): Promise<() => void> {
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

  async commitCleanup(tabId: number): Promise<void> {
    const barrier = this.cleanupBarriersByTab.get(tabId);
    if (!barrier) {
      await this.discard(tabId);
      return;
    }
    barrier.discardPromise ??= this.discard(tabId);
    await barrier.discardPromise;
  }

  assertCanStart(tabId: number): void {
    this._assertCanStartWork(tabId, this._getCancellationGeneration(tabId));
  }

  async _attach(
    target: DebuggerTarget,
    generation = this._getCancellationGeneration(target.tabId)
  ): Promise<void> {
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

  _nextDialogId(): string {
    this.nextDialogGeneration =
      this.nextDialogGeneration >= Number.MAX_SAFE_INTEGER ? 1 : this.nextDialogGeneration + 1;
    return `${this.dialogIdentityPrefix}:${this.nextDialogGeneration}`;
  }

  _recordDialogEvent(tabId: number, openedDialogId?: string): void {
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

  _settleDialogWaiters(tabId: number, dialog: TrackedDialog | null): void {
    const waiters = this.dialogWaitersByTab.get(tabId);
    if (!waiters) return;
    this.dialogWaitersByTab.delete(tabId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeoutId);
      waiter.resolve(dialog);
    }
  }

  /** Release standalone stateless reads on the next timer turn, allowing queued
work to reuse the attachment. Once a session needs burst retention, keep
the usual idle window until it detaches; a read must not shorten it. */
  _resetBurstTimer(tabId: number, target: DebuggerTarget, retainBurst: boolean = true): void {
    const existing = this.burstTimers.get(tabId);
    if (existing) clearTimeout(existing);
    if (retainBurst) this.burstRetainedTabs.add(tabId);
    const generation = this._getCancellationGeneration(tabId);
    const timer = setTimeout(
      async () => {
        await this.runExclusive(tabId, async () => {
          await this._waitForDialogLane(tabId);
          if (this.burstTimers.get(tabId) !== timer) return;
          this.burstTimers.delete(tabId);
          if (!this._isCancellationGenerationCurrent(tabId, generation)) return;
          if ((this.holdsByTab.get(tabId) ?? 0) > 0) return;
          if (this.dialogsByTab.has(tabId)) {
            this._resetBurstTimer(tabId, target);
            return;
          }
          try {
            await this.detach(target);
          } catch {
            // Already detached or tab closed.
          } finally {
            this.markDetached(tabId);
          }
        });
      },
      this.burstRetainedTabs.has(tabId) ? this.burstIdleMs : 0
    );
    timer.unref?.();
    this.burstTimers.set(tabId, timer);
  }

  /** Clear a pending burst-idle detach before starting new debugger work. */
  _consumeBurstTimer(tabId: number): boolean {
    const existing = this.burstTimers.get(tabId);
    if (!existing) return false;
    clearTimeout(existing);
    this.burstTimers.delete(tabId);
    return true;
  }

  /** Wait for all dialog turns that were authorized ahead of this normal turn.
Dialog turns never wait on the normal queue, so this cannot form a cycle. */
  async _waitForDialogLane(tabId: number): Promise<void> {
    let pending = this.pendingDialogsByTab.get(tabId);
    while (pending) {
      await pending.catch(() => {});
      const next = this.pendingDialogsByTab.get(tabId);
      if (!next || next === pending) return;
      pending = next;
    }
  }

  _getCancellationGeneration(tabId: number): number {
    return this.cancellationGenerationsByTab.get(tabId) ?? 0;
  }

  _isCancellationGenerationCurrent(tabId: number, generation: number): boolean {
    return this._getCancellationGeneration(tabId) === generation;
  }

  _assertCancellationGeneration(tabId: number, generation: number): void {
    if (!this._isCancellationGenerationCurrent(tabId, generation)) {
      throw createDebuggerCanceledError();
    }
  }

  _assertCanStartWork(tabId: number, generation: number): void {
    if (this.cleanupBarriersByTab.has(tabId)) throw createDebuggerCanceledError();
    const generations = this.inFlightTasksByTab.get(tabId);
    for (const [taskGeneration, count] of generations ?? []) {
      if (taskGeneration !== generation && count > 0) throw createDebuggerCanceledError();
    }
  }

  /** Keep the underlying multi-command task tied to its physical debugger
generation until it really settles. Cleanup may detach it, but a fresh
session cannot start while stale code could still issue another command. */
  async _runTrackedTask<T>(tabId: number, generation: number, task: () => Promise<T>): Promise<T> {
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

  /** Attach and keep a debugger session alive across multiple runs for the same
tab. Nested holds are reference-counted. */
  async acquire(
    tabId: number,
    initialize: (target: DebuggerTarget) => Promise<void> = async () => {}
  ): Promise<void> {
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

  /** Release one persistent debugger hold for a tab. */
  async release(
    tabId: number,
    cleanup: (target: DebuggerTarget) => Promise<void> = async () => {}
  ): Promise<void> {
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

/** Keep dialog text out of failure responses and persisted diagnostics. Reading
the message requires an explicit page.handle_dialog inspection. */
function createDialogBlockedError(
  tabId: number,
  dialog: TrackedDialog,
  actionStarted: boolean
): BridgeError {
  return new BridgeError(
    ERROR_CODES.DIALOG_BLOCKED,
    'A JavaScript dialog blocked the operation. Inspect it with page.handle_dialog; do not automatically replay the action.',
    {
      tabId,
      dialogId: dialog.dialogId,
      type: dialog.type,
      actionStarted,
      outcomeUncertain: actionStarted,
    }
  );
}

function normalizeDialogType(value: unknown): TrackedDialog['type'] {
  return value === 'confirm' || value === 'prompt' || value === 'beforeunload' ? value : 'alert';
}

function boundDialogText(value: unknown): { value: string; truncated: boolean } {
  const text = typeof value === 'string' ? value : '';
  return text.length <= MAX_DIALOG_TEXT_LENGTH
    ? { value: text, truncated: false }
    : { value: text.slice(0, MAX_DIALOG_TEXT_LENGTH), truncated: true };
}

function isDebuggerDetachedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not attached|no target with given id/i.test(message);
}

function createDebuggerCanceledError(): Error {
  return new Error('Debugger operation canceled because tab access was cleared.');
}

export function classifyDebuggerFailure(error: unknown): DebuggerReason | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/another debugger|debugger.{0,40}(?:already attached|conflict|in use)/iu.test(message)) {
    return 'debugger_conflict';
  }
  if (/not attached|no target with given id|debugger.{0,40}detach/iu.test(message)) {
    return 'debugger_detached';
  }
  return null;
}

function normalizeDetachReason(reason: unknown): DebuggerReason {
  if (reason === 'replaced_with_devtools') return 'debugger_replaced';
  if (reason === 'canceled_by_user') return 'debugger_canceled';
  if (reason === 'target_closed') return 'target_closed';
  return 'debugger_detached';
}
