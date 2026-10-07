// @ts-check

export const AGENT_GROUP_STORAGE_KEY = 'bbxAgentTabGroups';
export const AGENT_GROUP_TITLE = 'AI';
export const AGENT_GROUP_COLOR = 'blue';

/** @typedef {{ groupId: number, windowId: number, tabIds: number[] }} OwnedGroup */
/** @typedef {{ windowId: number | null, tabIds: Set<number> }} AgentActivity */

/**
 * Highlight contiguous runs without moving tabs or taking over user groups.
 * Only group IDs recorded in session storage belong to Browser Bridge.
 *
 * @param {typeof globalThis.chrome} chromeObj
 * @param {{ getActivity: () => Promise<AgentActivity> }} deps
 * @returns {{ sync: () => Promise<void> }}
 */
export function createAgentTabGroupController(chromeObj, deps) {
  /** @type {Map<number, OwnedGroup>} */
  const owned = new Map();
  let loaded = false;
  /** @type {Promise<void> | null} */
  let pending = null;
  let dirty = false;

  /** @returns {Promise<void>} */
  async function persist() {
    await chromeObj.storage.session.set({ [AGENT_GROUP_STORAGE_KEY]: [...owned.values()] });
  }

  /** @returns {Promise<void>} */
  async function restore() {
    if (loaded) return;
    const stored = await chromeObj.storage.session.get(AGENT_GROUP_STORAGE_KEY);
    const records = stored[AGENT_GROUP_STORAGE_KEY];
    if (Array.isArray(records)) {
      for (const value of records) {
        if (!value || typeof value !== 'object') continue;
        const record = /** @type {Record<string, unknown>} */ (value);
        if (
          typeof record.groupId !== 'number' ||
          !Number.isSafeInteger(record.groupId) ||
          record.groupId < 0 ||
          typeof record.windowId !== 'number' ||
          !Number.isSafeInteger(record.windowId) ||
          record.windowId < 0 ||
          !Array.isArray(record.tabIds) ||
          !record.tabIds.length ||
          !record.tabIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
        )
          continue;
        owned.set(record.groupId, {
          groupId: record.groupId,
          windowId: record.windowId,
          tabIds: [...record.tabIds],
        });
      }
    }
    loaded = true;
  }

  /**
   * @param {OwnedGroup} record
   * @param {chrome.tabGroups.TabGroup} group
   * @param {chrome.tabs.Tab[]} members
   * @returns {boolean}
   */
  function isUnchanged(record, group, members) {
    return (
      group.windowId === record.windowId &&
      group.title === AGENT_GROUP_TITLE &&
      group.color === AGENT_GROUP_COLOR &&
      !group.collapsed &&
      !group.shared &&
      members.every((tab) => typeof tab.id === 'number' && record.tabIds.includes(tab.id))
    );
  }

  /**
   * Release a whole group. Ungrouping only its middle tabs can reorder tabs.
   * Recheck ownership because the user may edit groups while a sync is pending.
   *
   * @param {OwnedGroup} record
   * @param {boolean} [newGroup=false] A failed initial label update needs rollback.
   * @returns {Promise<void>}
   */
  async function release(record, newGroup = false) {
    const members = await chromeObj.tabs.query({ groupId: record.groupId });
    const group = await chromeObj.tabGroups.get(record.groupId).catch(() => null);
    if (
      members.length &&
      group &&
      (newGroup || isUnchanged(record, group, members)) &&
      members.every((tab) => typeof tab.id === 'number' && record.tabIds.includes(tab.id))
    ) {
      const [first, ...rest] = members.flatMap((tab) =>
        typeof tab.id === 'number' ? [tab.id] : []
      );
      if (first !== undefined) await chromeObj.tabs.ungroup([first, ...rest]);
    }
    owned.delete(record.groupId);
    await persist();
  }

  /** @returns {Promise<void>} */
  async function reconcile() {
    if (
      !chromeObj.tabGroups?.get ||
      !chromeObj.tabGroups?.update ||
      !chromeObj.tabs.group ||
      !chromeObj.tabs.ungroup
    )
      return;
    await restore();
    const activity = await deps.getActivity();
    const allTabs = (await chromeObj.tabs.query({})).sort(
      (left, right) => left.windowId - right.windowId || left.index - right.index
    );
    for (const record of [...owned.values()]) {
      const members = allTabs.filter((tab) => tab.groupId === record.groupId);
      /** @type {chrome.tabGroups.TabGroup} */
      let group;
      try {
        group = await chromeObj.tabGroups.get(record.groupId);
      } catch {
        owned.delete(record.groupId);
        await persist();
        continue;
      }
      if (!isUnchanged(record, group, members)) {
        // A renamed, recolored, collapsed, moved, or expanded-by-user group is
        // now user-owned. Never change it or its members again.
        owned.delete(record.groupId);
        await persist();
      }
    }

    /** @type {chrome.tabs.Tab[][]} */
    const blocks = [];
    /** @type {chrome.tabs.Tab[]} */
    let block = [];
    for (const tab of allTabs) {
      const eligible =
        typeof tab.id === 'number' &&
        tab.windowId === activity.windowId &&
        activity.tabIds.has(tab.id) &&
        !tab.pinned &&
        (tab.groupId === chromeObj.tabGroups.TAB_GROUP_ID_NONE || owned.has(tab.groupId));
      if (!eligible) {
        block = [];
        continue;
      }
      const previous = block.at(-1);
      if (!previous || previous.windowId !== tab.windowId || previous.index + 1 !== tab.index) {
        block = [];
        blocks.push(block);
      }
      block.push(tab);
    }

    /** @type {Set<number>} */
    const kept = new Set();
    for (const record of [...owned.values()]) {
      const members = allTabs.filter((tab) => tab.groupId === record.groupId);
      const matching = blocks.find(
        (tabs) =>
          tabs.length === members.length &&
          tabs.every((tab, index) => tab.groupId === record.groupId && tab.id === members[index].id)
      );
      if (matching) {
        kept.add(record.groupId);
      } else {
        await release(record);
      }
    }

    for (const tabs of blocks) {
      if (kept.has(tabs[0].groupId)) continue;
      const [first, ...rest] = tabs.flatMap((tab) => (typeof tab.id === 'number' ? [tab.id] : []));
      if (first === undefined) continue;
      /** @type {[number, ...number[]]} */
      const tabIds = [first, ...rest];
      // Query again after ungrouping. Never group a stale, non-adjacent list:
      // Chrome would otherwise move tabs to make the group contiguous.
      const current = (await chromeObj.tabs.query({ windowId: tabs[0].windowId })).sort(
        (left, right) => left.index - right.index
      );
      const start = current.findIndex((tab) => tab.id === tabIds[0]);
      const latest = await deps.getActivity();
      if (
        start < 0 ||
        latest.windowId !== tabs[0].windowId ||
        !tabIds.every((id, index) => {
          const tab = current[start + index];
          return (
            tab?.id === id &&
            !tab.pinned &&
            tab.groupId === chromeObj.tabGroups.TAB_GROUP_ID_NONE &&
            latest.tabIds.has(id)
          );
        })
      )
        continue;
      const groupId = await chromeObj.tabs.group({
        tabIds,
        createProperties: { windowId: tabs[0].windowId },
      });
      const record = { groupId, windowId: tabs[0].windowId, tabIds };
      owned.set(groupId, record);
      try {
        await chromeObj.tabGroups.update(groupId, {
          title: AGENT_GROUP_TITLE,
          color: AGENT_GROUP_COLOR,
        });
        await persist();
      } catch (error) {
        await release(record, true);
        throw error;
      }
    }
  }

  return {
    sync() {
      dirty = true;
      if (!pending) {
        pending = Promise.resolve()
          .then(async () => {
            while (dirty) {
              dirty = false;
              await reconcile();
            }
          })
          .finally(() => {
            pending = null;
          });
      }
      return pending;
    },
  };
}
