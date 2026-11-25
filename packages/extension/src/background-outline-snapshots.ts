/** Background half of DOM outline snapshots. Content scripts keep the line
hashes per frame document; this store binds each snapshotId to its tab and to
the frames that took part, so an ID from another tab never reaches a content
script and a child frame that went away or navigated can be reported. */

export type OutlineDeltaReason =
  import('../../../protocol/src/types.js').DomOutlineDeltaUnavailableReason;

export const OUTLINE_SNAPSHOT_TTL_MS = 300_000;
export const OUTLINE_SNAPSHOTS_PER_TAB = 4;
const OUTLINE_TOMBSTONE_LIMIT = 64;

export type OutlineSnapshotRecord = {
  tabId: number;
  /** Frames whose lines the agent received with this snapshot. */
  frames: number[];
  createdAt: number;
  /** The merged response dropped child-frame lines at maxNodes. */
  cut: boolean;
};

export type OutlineReadPlan = {
  snapshotId: string;
  /** The base to compare with, or null for a full read. */
  since: string | null;
  base: OutlineSnapshotRecord | null;
  /** Set when since was given but cannot be used; the read is then full. */
  unavailable: OutlineDeltaReason | null;
};

export type OutlineSnapshotStore = ReturnType<typeof createOutlineSnapshotStore>;

function mintSnapshotId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `ol_${Array.from(bytes, (byte) => (byte % 36).toString(36)).join('')}`;
}

export function createOutlineSnapshotStore(
  options: { now?: () => number; mint?: () => string } = {}
) {
  const now = options.now ?? (() => Date.now());
  const mint = options.mint ?? mintSnapshotId;
  const records = new Map<string, OutlineSnapshotRecord>();
  const tombstones = new Map<string, { tabId: number; reason: 'expired' | 'evicted' }>();

  function tombstone(id: string, tabId: number, reason: 'expired' | 'evicted'): void {
    tombstones.delete(id);
    tombstones.set(id, { tabId, reason });
    while (tombstones.size > OUTLINE_TOMBSTONE_LIMIT) {
      const oldest = tombstones.keys().next();
      if (oldest.done) break;
      tombstones.delete(oldest.value);
    }
  }

  function expire(): void {
    const current = now();
    for (const [id, record] of records) {
      if (current - record.createdAt <= OUTLINE_SNAPSHOT_TTL_MS) continue;
      records.delete(id);
      tombstone(id, record.tabId, 'expired');
    }
  }

  /** Mint the next snapshotId and decide whether since can be used. */
  function begin(tabId: number, since: string | null): OutlineReadPlan {
    expire();
    const snapshotId = mint();
    if (!since) return { snapshotId, since: null, base: null, unavailable: null };
    const base = records.get(since);
    if (!base) {
      const gone = tombstones.get(since);
      return {
        snapshotId,
        since: null,
        base: null,
        // An unknown ID most likely outlived a service-worker restart.
        unavailable: gone ? (gone.tabId === tabId ? gone.reason : 'navigated') : 'expired',
      };
    }
    if (base.tabId !== tabId)
      return { snapshotId, since: null, base: null, unavailable: 'navigated' };
    if (base.cut) return { snapshotId, since: null, base, unavailable: 'base_truncated' };
    return { snapshotId, since, base, unavailable: null };
  }

  /** Record a snapshot the agent received. */
  function commit(tabId: number, snapshotId: string, frames: number[], cut: boolean): void {
    records.delete(snapshotId);
    records.set(snapshotId, { tabId, frames: [...new Set(frames)], createdAt: now(), cut });
    const owned = [...records].filter(([, record]) => record.tabId === tabId);
    for (const [id] of owned.slice(0, Math.max(0, owned.length - OUTLINE_SNAPSHOTS_PER_TAB))) {
      records.delete(id);
      tombstone(id, tabId, 'evicted');
    }
  }

  function clearTab(tabId: number): void {
    for (const [id, record] of records) if (record.tabId === tabId) records.delete(id);
    for (const [id, gone] of tombstones) if (gone.tabId === tabId) tombstones.delete(id);
  }

  function clearAll(): void {
    records.clear();
    tombstones.clear();
  }

  return { begin, commit, clearTab, clearAll, size: () => records.size };
}

/** Shared by every tab-bound outline read in this service worker. */
export const outlineSnapshots = createOutlineSnapshotStore();

type FrameResult = { frameId: number; result: Record<string, unknown> };

/** A content result that compares with a base: unchanged or a delta. */
export function isOutlineComparison(result: Record<string, unknown>): boolean {
  return result.unchanged === true || (result.delta !== null && typeof result.delta === 'object');
}

function readDelta(result: Record<string, unknown>): {
  added: unknown[];
  changed: unknown[];
  removed: string[];
} {
  const delta = (result.delta ?? {}) as Record<string, unknown>;
  return {
    added: Array.isArray(delta.added) ? delta.added : [],
    changed: Array.isArray(delta.changed) ? delta.changed : [],
    removed: Array.isArray(delta.removed)
      ? delta.removed.filter((ref): ref is string => typeof ref === 'string')
      : [],
  };
}

/** All current lines of a full frame result. */
function fullLines(result: Record<string, unknown>, format: 'tree' | 'outline'): unknown[] {
  if (format === 'tree') return Array.isArray(result.nodes) ? result.nodes : [];
  return typeof result.outline === 'string' && result.outline ? result.outline.split('\n') : [];
}

/** Child lines placed as a full merged read places them. */
function frameSection(frameId: number, lines: unknown[], format: 'tree' | 'outline'): unknown[] {
  if (!lines.length) return [];
  if (format === 'tree')
    return lines.map((node) => ({ ...(node as Record<string, unknown>), frameId }));
  return [`- iframe [frame ${frameId}]`, ...lines.map((line) => `  ${String(line)}`)];
}

/** Merge per-frame comparisons into one tab-level result. A child frame with
no usable base contributes its full outline as added lines; when the agent
already held lines from it, the frame is listed in removedFrames. Returns
overflow when a full read would exceed maxNodes, which a delta cannot show. */
export function mergeOutlineDeltas(input: {
  top: Record<string, unknown>;
  children: FrameResult[];
  baseFrames: number[];
  incompleteFrames: number[];
  format: 'tree' | 'outline';
  maxNodes: number;
  scanned: number;
  truncated: boolean;
  frameMetadata: Record<string, unknown>;
}): { overflow: boolean; result: Record<string, unknown> } {
  const { top, children, format } = input;
  const total =
    Number(top.count ?? 0) +
    children.reduce((sum, entry) => sum + Number(entry.result.count ?? 0), 0);
  const topDelta = readDelta(top);
  const added: unknown[] = [...topDelta.added];
  const changed: unknown[] = [...topDelta.changed];
  const removed: string[] = [...topDelta.removed];
  const removedFrames: number[] = [];
  const responded = new Set(children.map((entry) => entry.frameId));
  for (const frameId of input.baseFrames) {
    if (frameId !== 0 && !responded.has(frameId) && !input.incompleteFrames.includes(frameId))
      removedFrames.push(frameId);
  }
  for (const { frameId, result } of children) {
    if (isOutlineComparison(result)) {
      const delta = readDelta(result);
      added.push(...frameSection(frameId, delta.added, format));
      changed.push(...frameSection(frameId, delta.changed, format));
      removed.push(...delta.removed);
      continue;
    }
    if (input.baseFrames.includes(frameId)) removedFrames.push(frameId);
    added.push(...frameSection(frameId, fullLines(result, format), format));
  }
  const rest = { ...top };
  for (const key of ['outline', 'nodes', 'delta', 'unchanged', 'deltaUnavailable'])
    delete rest[key];
  const unchanged = !added.length && !changed.length && !removed.length && !removedFrames.length;
  return {
    overflow: total > input.maxNodes,
    result: {
      ...rest,
      count: total,
      scanned: input.scanned,
      truncated: input.truncated,
      frames: children.length,
      ...input.frameMetadata,
      ...(unchanged
        ? { unchanged: true }
        : {
            delta: {
              added,
              changed,
              removed,
              ...(removedFrames.length
                ? { removedFrames: removedFrames.sort((a, b) => a - b) }
                : {}),
            },
          }),
    },
  };
}
