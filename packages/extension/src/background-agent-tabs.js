// @ts-check

/**
 * Working-tab leases keep each agent session on the tab it started in, even
 * after the user activates another tab in the enabled window. Leases persist in
 * `chrome.storage.session` so MV3 worker restarts do not silently re-route an
 * agent onto whatever tab happens to be active.
 */

export const AGENT_TAB_STORAGE_KEY = 'bbxAgentTabLeases';
export const DEFAULT_AGENT_SESSION = 'default';
export const AGENT_TAB_IDLE_MS = 15 * 60_000;
export const MAX_AGENT_TAB_LEASES = 16;
export const MAX_AGENT_RECENT_TABS = 16;

/** @typedef {{ tabId: number, windowId: number, lastUsedAt: number }} AgentRecentTab */

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   boundAt: number,
 *   lastUsedAt: number,
 *   closed: boolean,
 *   recentTabs?: AgentRecentTab[],
 * }} AgentTabLease
 */

/**
 * @typedef {{
 *   get: (key: string) => Promise<Record<string, unknown>>,
 *   set: (items: Record<string, unknown>) => Promise<void>,
 * }} AgentTabLeaseStorage
 */

/**
 * @typedef {{
 *   get: (session: string) => Promise<AgentTabLease | null>,
 *   bind: (session: string, tabId: number, windowId: number) => Promise<AgentTabLease>,
 *   touch: (session: string) => Promise<void>,
 *   markClosed: (session: string) => Promise<void>,
 *   handleTabRemoved: (tabId: number) => Promise<string[]>,
 *   handleTabMoved: (tabId: number, newWindowId: number) => Promise<string[]>,
 *   rebindWindow: (windowId: number, tabId: number) => Promise<number>,
 *   clear: () => Promise<void>,
 *   getWorkingTabIds: () => Promise<Set<number>>,
 *   list: () => Promise<Array<{ session: string } & AgentTabLease>>,
 *   listRecentTabs: () => Promise<AgentRecentTab[]>,
 * }} AgentTabLeaseStore
 */

/**
 * Normalize the optional agent session identifier carried in request meta.
 * Unidentified callers share the default session.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAgentSession(value) {
  if (typeof value !== 'string') return DEFAULT_AGENT_SESSION;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(trimmed) ? trimmed : DEFAULT_AGENT_SESSION;
}

/**
 * @param {unknown} value
 * @returns {AgentTabLease | null}
 */
function normalizeStoredLease(value) {
  if (!value || typeof value !== 'object') return null;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  const tabId = Number(candidate.tabId);
  const windowId = Number(candidate.windowId);
  const boundAt = Number(candidate.boundAt);
  const lastUsedAt = Number(candidate.lastUsedAt);
  if (![tabId, windowId, boundAt, lastUsedAt].every(Number.isFinite)) return null;
  const recentTabs = Array.isArray(candidate.recentTabs)
    ? candidate.recentTabs
        .flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const tab = /** @type {Record<string, unknown>} */ (entry);
          return typeof tab.tabId === 'number' &&
            Number.isSafeInteger(tab.tabId) &&
            tab.tabId > 0 &&
            tab.windowId === windowId &&
            typeof tab.lastUsedAt === 'number' &&
            Number.isFinite(tab.lastUsedAt)
            ? [{ tabId: tab.tabId, windowId, lastUsedAt: tab.lastUsedAt }]
            : [];
        })
        .slice(-MAX_AGENT_RECENT_TABS)
    : candidate.closed === true
      ? []
      : [{ tabId, windowId, lastUsedAt }];
  return { tabId, windowId, boundAt, lastUsedAt, closed: candidate.closed === true, recentTabs };
}

/**
 * @param {{
 *   storage?: AgentTabLeaseStorage | null,
 *   now?: () => number,
 *   idleMs?: number,
 *   maxLeases?: number,
 * }} [options]
 * @returns {AgentTabLeaseStore}
 */
export function createAgentTabLeaseStore(options = {}) {
  const storage = options.storage ?? null;
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? AGENT_TAB_IDLE_MS;
  const maxLeases = options.maxLeases ?? MAX_AGENT_TAB_LEASES;
  /** @type {Map<string, AgentTabLease>} */
  const leases = new Map();
  /** @type {Promise<void> | null} */
  let loading = null;

  /** @returns {Promise<void>} */
  function ensureLoaded() {
    if (!loading) {
      loading = (async () => {
        if (!storage) return;
        try {
          const stored = await storage.get(AGENT_TAB_STORAGE_KEY);
          const raw = stored?.[AGENT_TAB_STORAGE_KEY];
          if (!raw || typeof raw !== 'object') return;
          for (const [session, value] of Object.entries(raw)) {
            const lease = normalizeStoredLease(value);
            if (lease && !leases.has(session)) leases.set(session, lease);
          }
        } catch {
          // Storage is a best-effort cache; routing still works in memory.
        }
      })();
    }
    return loading;
  }

  /** @returns {Promise<void>} */
  async function persist() {
    if (!storage) return;
    try {
      await storage.set({ [AGENT_TAB_STORAGE_KEY]: Object.fromEntries(leases) });
    } catch {
      // Best effort only.
    }
  }

  /** @param {AgentTabLease} lease @returns {boolean} */
  function isExpired(lease) {
    return now() - lease.lastUsedAt > idleMs;
  }

  /** @returns {void} */
  function evictOverflow() {
    while (leases.size > maxLeases) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, lease] of leases) {
        if (lease.lastUsedAt < oldestAt) {
          oldestAt = lease.lastUsedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      leases.delete(oldestKey);
    }
  }

  return {
    async get(session) {
      await ensureLoaded();
      const lease = leases.get(session);
      if (!lease) return null;
      if (isExpired(lease)) {
        leases.delete(session);
        await persist();
        return null;
      }
      return { ...lease };
    },

    async bind(session, tabId, windowId) {
      await ensureLoaded();
      const timestamp = now();
      const previous = leases.get(session);
      const lease =
        previous && previous.tabId === tabId && previous.windowId === windowId && !previous.closed
          ? { ...previous, lastUsedAt: timestamp }
          : { tabId, windowId, boundAt: timestamp, lastUsedAt: timestamp, closed: false };
      // Explicit requests can alternate targets without changing the set shown
      // in the panel. Keep routing's single default tab separate from this list.
      lease.recentTabs = [
        ...(previous?.windowId === windowId ? (previous.recentTabs ?? []) : []).filter(
          (tab) => tab.tabId !== tabId && timestamp - tab.lastUsedAt <= idleMs
        ),
        { tabId, windowId, lastUsedAt: timestamp },
      ].slice(-MAX_AGENT_RECENT_TABS);
      leases.set(session, lease);
      evictOverflow();
      await persist();
      return { ...lease };
    },

    async touch(session) {
      await ensureLoaded();
      const lease = leases.get(session);
      if (!lease) return;
      lease.lastUsedAt = now();
      const recent = lease.recentTabs?.find((tab) => tab.tabId === lease.tabId);
      if (recent) recent.lastUsedAt = lease.lastUsedAt;
      await persist();
    },

    async markClosed(session) {
      await ensureLoaded();
      const lease = leases.get(session);
      if (!lease || lease.closed) return;
      lease.closed = true;
      lease.recentTabs = lease.recentTabs?.filter((tab) => tab.tabId !== lease.tabId);
      await persist();
    },

    async handleTabRemoved(tabId) {
      await ensureLoaded();
      /** @type {string[]} */
      const affected = [];
      for (const [session, lease] of leases) {
        const recent = lease.recentTabs ?? [];
        lease.recentTabs = recent.filter((tab) => tab.tabId !== tabId);
        let changed = recent.length !== lease.recentTabs.length;
        if (lease.tabId === tabId && !lease.closed) {
          lease.closed = true;
          changed = true;
        }
        if (changed) affected.push(session);
      }
      if (affected.length) await persist();
      return affected;
    },

    async handleTabMoved(tabId, newWindowId) {
      await ensureLoaded();
      /** @type {string[]} */
      const affected = [];
      for (const [session, lease] of leases) {
        const recent = lease.recentTabs ?? [];
        lease.recentTabs = recent.filter(
          (tab) => tab.tabId !== tabId || tab.windowId === newWindowId
        );
        const removedRecent = recent.length !== lease.recentTabs.length;
        if (lease.tabId !== tabId) {
          if (removedRecent) affected.push(session);
          continue;
        }
        // A tab dragged out and back into its window is usable again.
        const closed = lease.windowId !== newWindowId;
        if (lease.closed !== closed) {
          lease.closed = closed;
          affected.push(session);
          if (!closed) {
            lease.recentTabs.push({ tabId, windowId: lease.windowId, lastUsedAt: now() });
          }
        } else if (removedRecent) {
          affected.push(session);
        }
      }
      if (affected.length) await persist();
      return affected;
    },

    async rebindWindow(windowId, tabId) {
      await ensureLoaded();
      const timestamp = now();
      let count = 0;
      for (const [session, lease] of leases) {
        if (lease.windowId !== windowId || isExpired(lease)) continue;
        leases.set(session, {
          tabId,
          windowId,
          boundAt: timestamp,
          lastUsedAt: timestamp,
          closed: false,
          recentTabs: [{ tabId, windowId, lastUsedAt: timestamp }],
        });
        count += 1;
      }
      if (count === 0) {
        leases.set(DEFAULT_AGENT_SESSION, {
          tabId,
          windowId,
          boundAt: timestamp,
          lastUsedAt: timestamp,
          closed: false,
          recentTabs: [{ tabId, windowId, lastUsedAt: timestamp }],
        });
        count = 1;
      }
      await persist();
      return count;
    },

    async clear() {
      await ensureLoaded();
      if (!leases.size) return;
      leases.clear();
      await persist();
    },

    async getWorkingTabIds() {
      await ensureLoaded();
      /** @type {Set<number>} */
      const ids = new Set();
      for (const lease of leases.values()) {
        if (!lease.closed && !isExpired(lease)) ids.add(lease.tabId);
      }
      return ids;
    },

    async list() {
      await ensureLoaded();
      return [...leases.entries()]
        .filter(([, lease]) => !isExpired(lease))
        .map(([session, lease]) => ({ session, ...lease }));
    },

    async listRecentTabs() {
      await ensureLoaded();
      /** @type {Map<number, AgentRecentTab>} */
      const tabs = new Map();
      for (const lease of leases.values()) {
        for (const tab of lease.recentTabs ?? []) {
          if (now() - tab.lastUsedAt > idleMs) continue;
          const previous = tabs.get(tab.tabId);
          if (!previous || previous.lastUsedAt < tab.lastUsedAt) tabs.set(tab.tabId, { ...tab });
        }
      }
      return [...tabs.values()];
    },
  };
}
