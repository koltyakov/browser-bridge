/**
 * Idle cleanup for tabs the agent opened itself (tabs.create): garbage
 * collection for scratch tabs an agent left behind, independent of the "Close
 * BBX tabs when done" setting, which tells agents to close their own tabs. A
 * tab closes after its idle TTL passes with no agent request to it; TTL 0 marks
 * a tab the user asked for, which is never collected. Tabs the user opened
 * are never closed here, even when an agent worked in them; they only leave
 * the BBX tab group once agent activity goes idle (see background-agent-tabs).
 */

export type OwnedTabRecord = {
  windowId: number;
  enabledAt: number;
  idleTtlMs?: number;
  /** Last agent activity, persisted at most once per IDLE_ACTIVITY_PERSIST_MS so
   * the idle clock survives worker restarts. */
  lastActiveAt?: number;
};

/** Coarsest step of the persisted activity time. Restored clocks are moved
 * forward by this much, so a restart can delay closing but never hasten it. */
export const IDLE_ACTIVITY_PERSIST_MS = 60_000;

/** The activity-log entry for an idle close. It carries no tabId: the log drops
 * entries for tabs that no longer exist, and the tab's own history is cleared
 * when it closes. */
export function idleCloseLogEntry(
  tabId: number,
  idleMs: number
): { method: string; ok: true; summary: string } {
  return {
    method: 'tabs.idle_close',
    ok: true,
    summary: `Closed BBX tab ${tabId} after ${Math.round(idleMs / 60_000)} min without agent activity.`,
  };
}

export type IdleTabSweeperDeps = {
  /** Agent-opened tabs and their TTLs (state.aiCreatedTabs). */
  getOwnedTabs: () => Record<string, OwnedTabRecord>;
  /** The enabled window; tabs elsewhere belong to no current session. */
  getEnabledWindowId: () => number | null;
  /** A request to this tab is still running. */
  isBusy: (tabId: number) => boolean;
  getTab: (tabId: number) => Promise<chrome.tabs.Tab | null>;
  closeTab: (tabId: number) => Promise<void>;
  onClosed?: (tabId: number, idleMs: number) => void;
  /** Record lastActiveAt on the owned tab and persist it. */
  persistActivity?: (tabId: number, at: number) => void;
  now?: () => number;
  defaultTtlMs: number;
};

export function createIdleTabSweeper(deps: IdleTabSweeperDeps): {
  touch: (tabId: number) => void;
  sweep: () => Promise<number[]>;
  lastActivity: (tabId: number) => number | undefined;
} {
  const now = deps.now ?? Date.now;
  const lastActive = new Map<number, number>();
  let sweeping: Promise<number[]> | null = null;

  function touch(tabId: number): void {
    if (!Number.isSafeInteger(tabId) || tabId <= 0) return;
    const at = now();
    lastActive.set(tabId, at);
    const record = deps.getOwnedTabs()[String(tabId)];
    if (
      record &&
      !(
        typeof record.lastActiveAt === 'number' &&
        at - record.lastActiveAt < IDLE_ACTIVITY_PERSIST_MS
      )
    )
      deps.persistActivity?.(tabId, at);
  }

  async function runSweep(): Promise<number[]> {
    const owned = deps.getOwnedTabs();
    const windowId = deps.getEnabledWindowId();
    const closed: number[] = [];
    for (const id of lastActive.keys()) if (!owned[String(id)]) lastActive.delete(id);
    if (windowId === null) return closed;
    const timestamp = now();
    for (const [key, record] of Object.entries(owned)) {
      const tabId = Number(key);
      const ttl = record.idleTtlMs ?? deps.defaultTtlMs;
      if (!(ttl > 0) || record.windowId !== windowId) continue;
      // After a worker restart, resume from the persisted activity time, moved
      // forward by its persistence step. Without one, start the clock now.
      let last = lastActive.get(tabId);
      if (last === undefined) {
        const persisted = record.lastActiveAt;
        last =
          typeof persisted === 'number' && Number.isFinite(persisted)
            ? Math.min(timestamp, persisted + IDLE_ACTIVITY_PERSIST_MS)
            : timestamp;
        lastActive.set(tabId, last);
      }
      const idle = timestamp - last;
      if (idle < ttl || deps.isBusy(tabId)) continue;
      const tab = await deps.getTab(tabId);
      // A tab dragged to another window left this session; the user is
      // looking at an active tab, so leave it until they move on; a pinned tab
      // was claimed by the user.
      if (!tab || tab.windowId !== windowId || tab.active || tab.pinned) continue;
      // Ownership or agent activity can change while tabs.get is in flight.
      if (
        deps.getEnabledWindowId() !== windowId ||
        deps.getOwnedTabs()[key] !== record ||
        lastActive.get(tabId) !== last ||
        deps.isBusy(tabId)
      )
        continue;
      try {
        await deps.closeTab(tabId);
        lastActive.delete(tabId);
        closed.push(tabId);
        deps.onClosed?.(tabId, idle);
      } catch {
        // Closed already or not closable; the next sweep or removal event settles it.
      }
    }
    return closed;
  }

  return {
    touch,
    lastActivity: (tabId) => lastActive.get(tabId),
    sweep() {
      sweeping ??= runSweep().finally(() => {
        sweeping = null;
      });
      return sweeping;
    },
  };
}
