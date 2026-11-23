/**
 * Idle cleanup for tabs the agent opened itself (tabs.create). A tab closes
 * after its idle TTL passes with no agent request to it. Tabs the user opened
 * are never closed here, even when an agent worked in them; they only leave
 * the BBX tab group once agent activity goes idle (see background-agent-groups).
 */

export type OwnedTabRecord = { windowId: number; enabledAt: number; idleTtlMs?: number };

export type IdleTabSweeperDeps = {
  /** Agent-opened tabs and their TTLs (state.aiCreatedTabs). */
  getOwnedTabs: () => Record<string, OwnedTabRecord>;
  /** The enabled window; tabs elsewhere belong to no current session. */
  getEnabledWindowId: () => number | null;
  /** The user turned off closing BBX tabs. */
  closingAllowed: () => boolean;
  /** A request to this tab is still running. */
  isBusy: (tabId: number) => boolean;
  getTab: (tabId: number) => Promise<chrome.tabs.Tab | null>;
  closeTab: (tabId: number) => Promise<void>;
  onClosed?: (tabId: number, idleMs: number) => void;
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
    if (Number.isSafeInteger(tabId) && tabId > 0) lastActive.set(tabId, now());
  }

  async function runSweep(): Promise<number[]> {
    const owned = deps.getOwnedTabs();
    const windowId = deps.getEnabledWindowId();
    const closed: number[] = [];
    for (const id of lastActive.keys()) if (!owned[String(id)]) lastActive.delete(id);
    if (!deps.closingAllowed() || windowId === null) return closed;
    const timestamp = now();
    for (const [key, record] of Object.entries(owned)) {
      const tabId = Number(key);
      const ttl = record.idleTtlMs ?? deps.defaultTtlMs;
      if (!(ttl > 0) || record.windowId !== windowId) continue;
      // After a worker restart there is no activity record yet. Start the
      // clock now rather than closing a tab the agent may still be using.
      const last = lastActive.get(tabId);
      if (last === undefined) {
        lastActive.set(tabId, timestamp);
        continue;
      }
      const idle = timestamp - last;
      if (idle < ttl || deps.isBusy(tabId)) continue;
      const tab = await deps.getTab(tabId);
      // A tab dragged to another window left this session; the user is
      // looking at an active tab, so leave it until they move on.
      if (!tab || tab.windowId !== windowId || tab.active) continue;
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
