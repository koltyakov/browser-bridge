import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';

const MAX_REGEX_URL_LENGTH = 16_384;

export type NavigationKind =
  | 'current'
  | 'full-navigation'
  | 'tabs-url-update'
  | 'tabs-status-update'
  | 'pushState'
  | 'replaceState'
  | 'popstate'
  | 'hashchange';
export type SpaNavigationKind = 'pushState' | 'replaceState' | 'popstate' | 'hashchange';
export type WaitParams = import('../../../protocol/src/types.js').NormalizedWaitForLoadStateParams;

export type SignalLease = {
  channel: string;
  refs: number;
  installPromise: Promise<void>;
  refreshTail: Promise<void>;
};

export type NavigationWaiter = {
  tabId: number;
  windowId: number;
  params: WaitParams;
  startedAt: number;
  sawLoading: boolean;
  pendingKind: NavigationKind | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
  signalsHeld: boolean;
  settled: boolean;
  resolve: (value: {
    tab: chrome.tabs.Tab;
    elapsedMs: number;
    observedNavigationKind: NavigationKind;
  }) => void;
  reject: (error: unknown) => void;
};

/**
 * Coordinate event-aware URL waits. Event payloads are only hints;
 * chrome.tabs.get and current enabled-window state remain authoritative.
 */
export class NavigationWaitCoordinator {
  declare getTab: (tabId: number) => Promise<chrome.tabs.Tab>;
  declare hasWindowAccess: (windowId: number) => boolean;
  declare installSignals: (tabId: number, channel: string) => Promise<void>;
  declare uninstallSignals: (tabId: number, channel: string) => Promise<void>;
  declare createSignalChannel: () => string;
  declare now: () => number;
  declare waitersByTab: Map<number, Set<NavigationWaiter>>;
  declare signalsByTab: Map<number, SignalLease>;
  declare signalCleanupByTab: Map<number, Promise<void>>;

  constructor({
    getTab,
    hasWindowAccess = () => true,
    installSignals = async () => {},
    uninstallSignals = async () => {},
    createSignalChannel = () => globalThis.crypto.randomUUID(),
    now = Date.now,
  }: {
    getTab: (tabId: number) => Promise<chrome.tabs.Tab>;
    hasWindowAccess?: (windowId: number) => boolean;
    installSignals?: (tabId: number, channel: string) => Promise<void>;
    uninstallSignals?: (tabId: number, channel: string) => Promise<void>;
    createSignalChannel?: () => string;
    now?: () => number;
  }) {
    this.getTab = getTab;
    this.hasWindowAccess = hasWindowAccess;
    this.installSignals = installSignals;
    this.uninstallSignals = uninstallSignals;
    this.createSignalChannel = createSignalChannel;
    this.now = now;

    this.waitersByTab = new Map();

    this.signalsByTab = new Map();

    this.signalCleanupByTab = new Map();
  }

  /** Register synchronously before any tab read or instrumentation await so
access revocation and tab-removal events cannot pass an untracked waiter. */
  wait(
    tabId: number,
    windowId: number,
    params: WaitParams
  ): Promise<{ tab: chrome.tabs.Tab; elapsedMs: number; observedNavigationKind: NavigationKind }> {
    return new Promise((resolve, reject) => {
      const waiter: NavigationWaiter = {
        tabId,
        windowId,
        params,
        startedAt: this.now(),
        sawLoading: false,
        pendingKind: null,
        timeoutId: null,
        signalsHeld: false,
        settled: false,
        resolve,
        reject,
      };
      const tabWaiters = this.waitersByTab.get(tabId) ?? new Set();
      tabWaiters.add(waiter);
      this.waitersByTab.set(tabId, tabWaiters);
      waiter.timeoutId = setTimeout(() => void this._timeout(waiter), params.timeoutMs);
      void this._start(waiter);
    });
  }

  handleTabUpdated(
    tabId: number,
    changeInfo: { status?: string; url?: string },
    tab?: chrome.tabs.Tab
  ): void {
    const waiters = this.waitersByTab.get(tabId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (tab && tab.windowId !== waiter.windowId) {
        this._reject(waiter, movedTabError());
        continue;
      }
      if (changeInfo.status === 'loading') {
        waiter.sawLoading = true;
        waiter.pendingKind = 'full-navigation';
      }

      let kind: NavigationKind = waiter.sawLoading ? 'full-navigation' : 'tabs-status-update';
      if (typeof changeInfo.url === 'string') {
        kind = waiter.sawLoading ? 'full-navigation' : 'tabs-url-update';
      }
      void this._check(waiter, kind);
    }
    if (changeInfo.status === 'complete') void this._refreshSignals(tabId);
  }

  handleTabMoved(tabId: number, windowId: number | null) {
    const waiters = this.waitersByTab.get(tabId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (windowId === null || windowId !== waiter.windowId) {
        this._reject(waiter, movedTabError());
      }
    }
  }

  handleSpaSignal(tabId: number, kind: SpaNavigationKind, channel?: string) {
    const lease = this.signalsByTab.get(tabId);
    if (!lease || (channel !== undefined && channel !== lease.channel)) return;
    const waiters = this.waitersByTab.get(tabId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      waiter.pendingKind = kind;
      void this._check(waiter, kind);
    }
  }

  handleTabRemoved(tabId: number) {
    this.cancelTab(
      tabId,
      new BridgeError(ERROR_CODES.TAB_MISMATCH, 'Tab was closed while waiting for URL')
    );
  }

  cancelTab(tabId: number, error: BridgeError) {
    const waiters = this.waitersByTab.get(tabId);
    if (!waiters) return;
    for (const waiter of [...waiters]) this._reject(waiter, error);
  }

  cancelWindow(windowId: number) {
    for (const waiters of this.waitersByTab.values()) {
      for (const waiter of [...waiters]) {
        if (waiter.windowId === windowId) this._reject(waiter, accessChangedError());
      }
    }
  }

  async _start(waiter: NavigationWaiter) {
    try {
      const initial = await this._readScopedTab(waiter);
      if (waiter.settled) return;
      waiter.sawLoading = waiter.sawLoading || initial.status === 'loading';
      if (waiter.sawLoading) waiter.pendingKind = 'full-navigation';
      if (isSatisfied(initial, waiter.params)) {
        this._resolve(waiter, initial, 'current');
        return;
      }
      await this._acquireSignals(waiter);
      if (!waiter.settled) await this._check(waiter, 'current');
    } catch (error) {
      if (!waiter.settled) this._reject(waiter, normalizeWaitError(error));
    }
  }

  async _check(waiter: NavigationWaiter, observedKind: NavigationKind) {
    if (waiter.settled) return;
    try {
      const tab = await this._readScopedTab(waiter);
      if (waiter.settled || !isSatisfied(tab, waiter.params)) return;
      this._resolve(waiter, tab, waiter.pendingKind ?? observedKind);
    } catch (error) {
      if (!waiter.settled) this._reject(waiter, normalizeWaitError(error));
    }
  }

  async _readScopedTab(waiter: NavigationWaiter) {
    this._assertAccess(waiter);
    let tab;
    try {
      tab = await this.getTab(waiter.tabId);
    } catch (error) {
      throw new BridgeError(ERROR_CODES.TAB_MISMATCH, 'Tab was closed while waiting for URL', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    this._assertAccess(waiter);
    if (tab.windowId !== waiter.windowId) throw movedTabError();
    return tab;
  }

  _assertAccess(waiter: NavigationWaiter) {
    if (!this.hasWindowAccess(waiter.windowId)) throw accessChangedError();
  }

  async _acquireSignals(waiter: NavigationWaiter) {
    const cleanup = this.signalCleanupByTab.get(waiter.tabId);
    if (cleanup) await cleanup;
    if (waiter.settled) return;
    this._assertAccess(waiter);

    let lease = this.signalsByTab.get(waiter.tabId);
    if (!lease) {
      const channel = this.createSignalChannel();
      const installPromise = this.installSignals(waiter.tabId, channel);
      lease = { channel, refs: 0, installPromise, refreshTail: installPromise };
      this.signalsByTab.set(waiter.tabId, lease);
    }
    lease.refs += 1;
    waiter.signalsHeld = true;
    await lease.installPromise;
    if (!waiter.settled) {
      this._assertAccess(waiter);
      await this._readScopedTab(waiter);
    }
  }

  async _refreshSignals(tabId: number) {
    const lease = this.signalsByTab.get(tabId);
    if (!lease) return;
    lease.refreshTail = lease.refreshTail.then(() => this.installSignals(tabId, lease.channel));
    try {
      await lease.refreshTail;
    } catch (error) {
      this.cancelTab(tabId, normalizeWaitError(error));
    }
  }

  _releaseSignals(waiter: NavigationWaiter) {
    if (!waiter.signalsHeld) return;
    waiter.signalsHeld = false;
    const lease = this.signalsByTab.get(waiter.tabId);
    if (!lease || --lease.refs > 0) return;
    this.signalsByTab.delete(waiter.tabId);
    const cleanup = lease.refreshTail
      .then(() => this.uninstallSignals(waiter.tabId, lease.channel))
      .catch(() => {});
    this.signalCleanupByTab.set(waiter.tabId, cleanup);
    void cleanup.finally(() => {
      if (this.signalCleanupByTab.get(waiter.tabId) === cleanup) {
        this.signalCleanupByTab.delete(waiter.tabId);
      }
    });
  }

  async _timeout(waiter: NavigationWaiter) {
    if (waiter.settled) return;
    let finalUrl = null;
    try {
      const tab = await this._readScopedTab(waiter);
      if (waiter.settled) return;
      finalUrl = tab.url ?? null;
      if (isSatisfied(tab, waiter.params)) {
        this._resolve(waiter, tab, waiter.pendingKind ?? 'current');
        return;
      }
    } catch (error) {
      if (!waiter.settled) this._reject(waiter, normalizeWaitError(error));
      return;
    }
    this._reject(
      waiter,
      new BridgeError(
        ERROR_CODES.TIMEOUT,
        `Timed out waiting for tab ${waiter.tabId} to match the URL condition after ${waiter.params.timeoutMs}ms.`,
        { finalUrl, elapsedMs: this.now() - waiter.startedAt }
      )
    );
  }

  _resolve(waiter: NavigationWaiter, tab: chrome.tabs.Tab, kind: NavigationKind) {
    if (waiter.settled) return;
    try {
      this._assertAccess(waiter);
      if (tab.windowId !== waiter.windowId) throw movedTabError();
    } catch (error) {
      this._reject(waiter, error);
      return;
    }
    this._cleanup(waiter);
    waiter.resolve({
      tab,
      elapsedMs: this.now() - waiter.startedAt,
      observedNavigationKind: kind,
    });
  }

  _cleanup(waiter: NavigationWaiter) {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
    const waiters = this.waitersByTab.get(waiter.tabId);
    waiters?.delete(waiter);
    if (waiters?.size === 0) this.waitersByTab.delete(waiter.tabId);
    this._releaseSignals(waiter);
  }

  _reject(waiter: NavigationWaiter, error: unknown) {
    if (waiter.settled) return;
    this._cleanup(waiter);
    waiter.reject(error);
  }
}

function accessChangedError(): BridgeError {
  return new BridgeError(ERROR_CODES.ACCESS_DENIED, 'Window access changed while waiting for URL');
}

function movedTabError(): BridgeError {
  return new BridgeError(
    ERROR_CODES.ACCESS_DENIED,
    'Tab moved outside the enabled window while waiting for URL'
  );
}

function normalizeWaitError(error: unknown): BridgeError {
  return error instanceof BridgeError
    ? error
    : new BridgeError(ERROR_CODES.INTERNAL_ERROR, 'URL wait instrumentation failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
}

function isSatisfied(tab: chrome.tabs.Tab, params: WaitParams): boolean {
  if (params.waitForLoad && tab.status !== 'complete') return false;
  if (!params.url || !params.urlMatch || typeof tab.url !== 'string') return true;
  if (params.urlMatch === 'exact') return tab.url === params.url;
  if (params.urlMatch === 'contains') return tab.url.includes(params.url);
  if (tab.url.length > MAX_REGEX_URL_LENGTH) return false;
  return new RegExp(params.url).test(tab.url);
}
