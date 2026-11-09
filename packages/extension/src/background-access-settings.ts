import { getAccessSettingsSnapshot, normalizeAccessSettings } from './access-settings.js';
import type { ExtensionState } from './background-state.js';
import { isUnavailableDocumentError, normalizeRuntimeErrorMessage } from './background-helpers.js';
import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';
import { isGrantedTab, sameWindowGrant, type EnabledWindowState } from './background-access.js';

export const ACCESS_SETTINGS_STORAGE_KEY = 'accessSettings';
export const AI_TABS_STORAGE_KEY = 'aiCreatedTabs';
export const INHERITED_TABS_STORAGE_KEY = 'inheritedTabs';
export const ACCESS_SETTINGS_REVISION_KEY = 'accessSettingsRevision';

/** Only tabs created through tabs.create are AI-owned, never merely inspected tabs. */
export function createAccessSettingsController(
  state: ExtensionState,
  chrome: typeof globalThis.chrome,
  options: { onChanged?: () => void } = {}
) {
  let tail = Promise.resolve();
  let committed = getAccessSettingsSnapshot(state);
  const waiters = new Set<() => void>();
  function changed(): void {
    for (const notify of [...waiters]) notify();
    options.onChanged?.();
  }
  function enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = tail.then(operation, operation);
    tail = pending.catch(() => {});
    return pending;
  }

  return {
    async restore(): Promise<void> {
      const [local, session] = await Promise.all([
        chrome.storage.local.get([ACCESS_SETTINGS_STORAGE_KEY, ACCESS_SETTINGS_REVISION_KEY]),
        chrome.storage.session.get([AI_TABS_STORAGE_KEY, INHERITED_TABS_STORAGE_KEY]),
      ]);
      state.accessSettings = normalizeAccessSettings(local[ACCESS_SETTINGS_STORAGE_KEY]);
      const revision: unknown = local[ACCESS_SETTINGS_REVISION_KEY];
      if (typeof revision === 'string' && revision.length > 0 && revision.length <= 128)
        state.accessSettingsRevision = revision;
      committed = getAccessSettingsSnapshot(state);
      for (const [key, target] of [
        [AI_TABS_STORAGE_KEY, state.aiCreatedTabs],
        [INHERITED_TABS_STORAGE_KEY, state.inheritedTabs],
      ] as const) {
        const stored: unknown = session[key];
        if (!stored || typeof stored !== 'object') continue;
        for (const [id, value] of Object.entries(stored)) {
          if (
            !Number.isSafeInteger(Number(id)) ||
            Number(id) <= 0 ||
            !value ||
            typeof value !== 'object'
          )
            continue;
          const tab = value as Record<string, unknown>;
          if (typeof tab.windowId === 'number' && typeof tab.enabledAt === 'number') {
            target[id] = { windowId: tab.windowId, enabledAt: tab.enabledAt };
          }
        }
      }
    },
    update(value: unknown): Promise<void> {
      const settings = normalizeAccessSettings(value);
      if (
        (Object.keys(settings) as Array<keyof typeof settings>).every(
          (key) => settings[key] === state.accessSettings[key]
        )
      )
        return tail;
      const revision = crypto.randomUUID();
      // Enforce the user's latest choice before asynchronous persistence completes.
      state.accessSettings = settings;
      state.accessSettingsRevision = revision;
      changed();
      return enqueue(async () => {
        try {
          await chrome.storage.local.set({
            [ACCESS_SETTINGS_STORAGE_KEY]: settings,
            [ACCESS_SETTINGS_REVISION_KEY]: revision,
          });
          committed = { settings: { ...settings }, settingsRevision: revision };
        } catch (error) {
          if (state.accessSettingsRevision === revision) {
            state.accessSettings = { ...committed.settings };
            state.accessSettingsRevision = crypto.randomUUID();
            changed();
          }
          throw error;
        }
      });
    },
    waitForChange(
      revision: string,
      timeoutMs: number,
      trackCancellation: (cancel: () => void) => () => void = () => () => {}
    ): Promise<import('../../../protocol/src/types.js').AccessWaitForChangeResult> {
      if (revision !== state.accessSettingsRevision || timeoutMs === 0)
        return Promise.resolve({
          changed: revision !== state.accessSettingsRevision,
          ...getAccessSettingsSnapshot(state),
        });
      if (waiters.size >= 32)
        return Promise.reject(
          new BridgeError(ERROR_CODES.INVALID_REQUEST, 'Access-setting wait capacity reached.')
        );
      return new Promise((resolve, reject) => {
        let settled = false;
        let untrack = () => {};
        const finish = (canceled = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(notify);
          untrack();
          if (canceled)
            reject(
              new BridgeError(
                ERROR_CODES.TIMEOUT,
                'Access-setting wait canceled. No browser action was dispatched.'
              )
            );
          else
            resolve({
              changed: revision !== state.accessSettingsRevision,
              ...getAccessSettingsSnapshot(state),
            });
        };
        const notify = () => finish();
        const timer = setTimeout(notify, timeoutMs);
        waiters.add(notify);
        untrack = trackCancellation(() => finish(true));
        if (settled) untrack();
      });
    },
    track(tabId: number, grant: { windowId: number; enabledAt: number }): Promise<void> {
      return enqueue(async () => {
        state.aiCreatedTabs[String(tabId)] = {
          windowId: grant.windowId,
          enabledAt: grant.enabledAt,
        };
        await chrome.storage.session.set({ [AI_TABS_STORAGE_KEY]: { ...state.aiCreatedTabs } });
      });
    },
    /** Linked user tabs inherit authorization, not AI ownership or auto-close permission. */
    inherit(
      tab: chrome.tabs.Tab,
      grant: EnabledWindowState | null = state.enabledWindow ? { ...state.enabledWindow } : null
    ): Promise<void> {
      return enqueue(async () => {
        if (
          !grant ||
          grant.tabId === undefined ||
          tab.id === undefined ||
          tab.openerTabId === undefined ||
          tab.windowId !== grant.windowId ||
          !sameWindowGrant(grant, state.enabledWindow) ||
          !isGrantedTab(state, tab.openerTabId, tab.windowId)
        )
          return;
        const [current, opener] = await Promise.all([
          chrome.tabs.get(tab.id).catch(() => null),
          chrome.tabs.get(tab.openerTabId).catch(() => null),
        ]);
        if (
          current?.windowId !== grant.windowId ||
          opener?.windowId !== grant.windowId ||
          !sameWindowGrant(grant, state.enabledWindow) ||
          !isGrantedTab(state, tab.openerTabId, grant.windowId)
        )
          return;
        state.inheritedTabs[String(tab.id)] = {
          windowId: grant.windowId,
          enabledAt: grant.enabledAt,
        };
        await chrome.storage.session.set({
          [INHERITED_TABS_STORAGE_KEY]: { ...state.inheritedTabs },
        });
      });
    },
    forget(tabId: number): Promise<void> {
      return enqueue(async () => {
        delete state.aiCreatedTabs[String(tabId)];
        delete state.inheritedTabs[String(tabId)];
        await chrome.storage.session.set({
          [AI_TABS_STORAGE_KEY]: { ...state.aiCreatedTabs },
          [INHERITED_TABS_STORAGE_KEY]: { ...state.inheritedTabs },
        });
      });
    },
    async closeWhenDone(windowId: number): Promise<void> {
      await tail;
      if (!state.accessSettings.closeAiTabsWhenDone) return;
      const errors: unknown[] = [];
      for (const [id, owner] of Object.entries(state.aiCreatedTabs)) {
        if (owner.windowId !== windowId) continue;
        let tab: chrome.tabs.Tab;
        try {
          tab = await chrome.tabs.get(Number(id));
        } catch {
          continue;
        }
        // A tab moved to another window is no longer part of this access session.
        if (tab.windowId !== windowId) continue;
        try {
          await chrome.tabs.remove(Number(id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            normalizeRuntimeErrorMessage(message) !== ERROR_CODES.TAB_MISMATCH &&
            !isUnavailableDocumentError(message)
          ) {
            errors.push(new Error(`Could not close BBX tab ${id}`, { cause: error }));
          }
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Some BBX tabs could not be closed.');
    },
  };
}
