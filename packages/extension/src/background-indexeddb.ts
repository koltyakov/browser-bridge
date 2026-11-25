import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';
import type {
  ErrorCode,
  IndexedDbFrameMetadata,
  IndexedDbStorageResult,
  NormalizedSensitiveIndexedDbReadParams,
  SensitiveIndexedDbReadResult,
} from '../../../protocol/src/types.js';
import type { ResolvedTabTarget } from './background-tab-bound.js';

export type IndexedDbFrames = {
  listFrames: (
    tabId: number,
    options?: { refresh?: boolean }
  ) => Promise<Array<{ frameId: number; tag: string | null }>>;
  sendFrameMessage: (
    tabId: number,
    frameId: number,
    message: Record<string, unknown>,
    timeoutMs: number
  ) => Promise<unknown>;
};

/** A child frame's walk is bounded at two seconds in the content script. */
export const INDEXEDDB_FRAME_TIMEOUT_MS = 3_000;
/** The content script bounds one record read at about three seconds. */
const INDEXEDDB_READ_TIMEOUT_MS = 5_000;

function frameEntry(frameId: number, raw: unknown): IndexedDbFrameMetadata | null {
  if (!raw || typeof raw !== 'object' || 'error' in raw) return null;
  const record = raw as Record<string, unknown>;
  return {
    frameId,
    origin: typeof record.origin === 'string' ? record.origin : '',
    available: record.available === true,
    databases: Array.isArray(record.databases)
      ? (record.databases as IndexedDbFrameMetadata['databases'])
      : [],
    total: typeof record.total === 'number' ? record.total : 0,
    incomplete: Array.isArray(record.incomplete)
      ? (record.incomplete as IndexedDbFrameMetadata['incomplete'])
      : [],
  };
}

/** Report IndexedDB metadata per frame. Each frame reads its own origin's
 * storage, so a cross-origin iframe is listed under its frameId and never
 * merged into the top document. */
export async function collectIndexedDbFrames(
  message: Record<string, unknown>,
  topResponse: unknown,
  tabId: number,
  frames: IndexedDbFrames | undefined
): Promise<unknown> {
  const top = frameEntry(0, topResponse);
  if (!top) return topResponse;
  const result: IndexedDbStorageResult = { type: 'indexeddb', frames: [top] };
  if (!frames) return result;
  const children = (await frames.listFrames(tabId)).filter((frame) => frame.frameId !== 0);
  const answers = await Promise.all(
    children.map(async (frame) => {
      try {
        return frameEntry(
          frame.frameId,
          await frames.sendFrameMessage(tabId, frame.frameId, message, INDEXEDDB_FRAME_TIMEOUT_MS)
        );
      } catch {
        return null;
      }
    })
  );
  const incompleteFrames: number[] = [];
  answers.forEach((entry, index) => {
    if (entry) result.frames.push(entry);
    else incompleteFrames.push(children[index].frameId);
  });
  if (incompleteFrames.length) result.incompleteFrames = incompleteFrames;
  return result;
}

export type IndexedDbReaderDependencies = {
  ensureContentScript: (tabId: number) => Promise<void>;
  frames: IndexedDbFrames;
};

/** Read one IndexedDB record in the frame that owns it. Callers reach this only
 * through the gated sensitive.read controller. */
export function createIndexedDbRecordReader(deps: IndexedDbReaderDependencies) {
  return async function read(
    target: ResolvedTabTarget,
    params: NormalizedSensitiveIndexedDbReadParams
  ): Promise<SensitiveIndexedDbReadResult> {
    await deps.ensureContentScript(target.tabId);
    if (params.frameId !== 0) {
      const known = await deps.frames.listFrames(target.tabId, { refresh: true });
      if (!known.some((frame) => frame.frameId === params.frameId))
        throw new BridgeError(
          ERROR_CODES.SENSITIVE_TARGET_NOT_FOUND,
          'No scriptable frame with that frameId exists in the tab.',
          { source: 'indexeddb', reason: 'frame_not_found', frameId: params.frameId }
        );
    }
    const response = (await deps.frames.sendFrameMessage(
      target.tabId,
      params.frameId,
      { type: 'bridge.execute', method: 'indexeddb.read_record', params },
      INDEXEDDB_READ_TIMEOUT_MS
    )) as Record<string, unknown> | null;
    if (!response || typeof response !== 'object')
      throw new BridgeError(ERROR_CODES.INTERNAL_ERROR, 'The frame returned no IndexedDB result.');
    if ('error' in response) {
      const error = response.error as
        | { code?: unknown; message?: unknown; details?: unknown }
        | string
        | null;
      const code =
        error && typeof error === 'object' && typeof error.code === 'string'
          ? (Object.values(ERROR_CODES) as string[]).find((known) => known === error.code)
          : undefined;
      // Only typed content errors pass through; their messages never carry
      // database, store, or key names. Anything else becomes a generic failure.
      if (code && error && typeof error === 'object')
        throw new BridgeError(
          code as ErrorCode,
          typeof error.message === 'string' ? error.message : 'IndexedDB read failed.',
          error.details && typeof error.details === 'object'
            ? error.details
            : { source: 'indexeddb' }
        );
      throw new BridgeError(ERROR_CODES.INTERNAL_ERROR, 'IndexedDB read failed.', {
        source: 'indexeddb',
      });
    }
    if (response.source !== 'indexeddb' || response.exact !== true)
      throw new BridgeError(ERROR_CODES.INTERNAL_ERROR, 'The frame returned an invalid record.');
    return { ...(response as unknown as SensitiveIndexedDbReadResult), frameId: params.frameId };
  };
}
