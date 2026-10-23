import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';

/** Capture authorization before an await; title-only updates keep it valid. */
export function captureWindowGrant(state: EnabledWindowContainer): () => void {
  const captured = state.enabledWindow ? { ...state.enabledWindow } : null;
  return () => {
    if (!sameWindowGrant(captured, state.enabledWindow)) {
      throw new BridgeError(
        ERROR_CODES.ACCESS_DENIED,
        'Window access changed during the operation.',
        {
          reason: 'window_access_changed',
        }
      );
    }
  };
}

/** Metadata updates preserve a grant; revocation or re-enabling does not. */
export function sameWindowGrant(
  captured: EnabledWindowState | null,
  current: EnabledWindowState | null
) {
  return Boolean(
    captured &&
    current &&
    captured.windowId === current.windowId &&
    captured.enabledAt === current.enabledAt
  );
}

export type EnabledWindowState = {
  windowId: number;
  title: string;
  enabledAt: number;
};

export type EnabledWindowContainer = { enabledWindow: EnabledWindowState | null };

export type AccessStatus = {
  enabled: boolean;
  windowId: number | null;
  routeTabId: number | null;
  routeReady: boolean;
  routeUrl: string;
  reason:
    | 'enabled'
    | 'access_disabled'
    | 'enabled_window_missing'
    | 'no_routable_active_tab'
    | 'restricted_page';
};

export function normalizeStoredEnabledWindow(
  value: unknown,
  now: () => number = Date.now
): EnabledWindowState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const windowId = Number(candidate.windowId);
  if (!Number.isFinite(windowId) || windowId <= 0) {
    return null;
  }

  return {
    windowId,
    title: typeof candidate.title === 'string' ? candidate.title : '',
    enabledAt: Number(candidate.enabledAt) || now(),
  };
}

/** Restore a previously-enabled window from session storage. */
export async function restoreEnabledWindowState({
  chrome,
  state,
  storageKey,
  sendAccessUpdate,
  now = Date.now,
}: {
  chrome: { storage: { session: { get: (key: string) => Promise<Record<string, unknown>> } } };
  state: EnabledWindowContainer;
  storageKey: string;
  sendAccessUpdate: (enabled: boolean) => void;
  now?: () => number;
}): Promise<void> {
  const stored = await chrome.storage.session.get(storageKey);
  const enabledWindow = normalizeStoredEnabledWindow(stored[storageKey], now);
  state.enabledWindow = enabledWindow;
  if (enabledWindow) {
    sendAccessUpdate(true);
  }
}

/** Build a compact access-status payload for health and doctor flows. */
export async function getAccessStatus({
  chrome,
  state,
  clearEnabledWindowIfGone,
  isRestrictedAutomationUrl,
}: {
  chrome: {
    windows: { get: (windowId: number) => Promise<unknown> };
    tabs: {
      query: (query: {
        active: boolean;
        windowId: number;
      }) => Promise<Array<{ id?: number; url?: unknown }>>;
    };
  };
  state: EnabledWindowContainer;
  clearEnabledWindowIfGone: () => Promise<boolean>;
  isRestrictedAutomationUrl: (url: string) => boolean;
}): Promise<AccessStatus> {
  if (!state.enabledWindow) {
    return {
      enabled: false,
      windowId: null,
      routeTabId: null,
      routeReady: false,
      routeUrl: '',
      reason: 'access_disabled',
    };
  }

  try {
    await chrome.windows.get(state.enabledWindow.windowId);
  } catch {
    const cleared = await clearEnabledWindowIfGone();
    if (cleared) {
      return {
        enabled: false,
        windowId: null,
        routeTabId: null,
        routeReady: false,
        routeUrl: '',
        reason: 'enabled_window_missing',
      };
    }
  }

  const tabs = await chrome.tabs.query({
    active: true,
    windowId: state.enabledWindow.windowId,
  });
  const tab = tabs[0];
  if (!tab?.id || typeof tab.url !== 'string') {
    return {
      enabled: true,
      windowId: state.enabledWindow.windowId,
      routeTabId: null,
      routeReady: false,
      routeUrl: '',
      reason: 'no_routable_active_tab',
    };
  }

  if (isRestrictedAutomationUrl(tab.url)) {
    return {
      enabled: true,
      windowId: state.enabledWindow.windowId,
      routeTabId: tab.id,
      routeReady: false,
      routeUrl: tab.url,
      reason: 'restricted_page',
    };
  }

  return {
    enabled: true,
    windowId: state.enabledWindow.windowId,
    routeTabId: tab.id,
    routeReady: true,
    routeUrl: tab.url,
    reason: 'enabled',
  };
}
