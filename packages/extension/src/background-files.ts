import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';
import {
  FILE_MAX_BYTES,
  FILE_TOTAL_BYTES,
  FILE_TTL_MS,
  normalizeFileParams,
} from '../../../protocol/src/files.js';

export type StagedFile = {
  id: string;
  owner: string;
  tabId: number;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  offset: number;
  expiresAt: number;
};

/** Chunked input keeps file bytes out of model responses and works across remote destinations. */
export function createFileStaging(deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now;

  const files: Map<string, StagedFile> = new Map();

  const timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  function discard(id: string) {
    files.delete(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
  }
  function prune() {
    for (const [id, file] of files) if (file.expiresAt <= now()) discard(id);
  }

  function get(id: string, owner: string, tabId: number) {
    prune();
    const file = files.get(id);
    if (!file || file.owner !== owner || file.tabId !== tabId)
      throw new BridgeError(
        ERROR_CODES.ARTIFACT_NOT_FOUND,
        'Staged file expired or belongs to another tab/session. Stage it again.'
      );
    return file;
  }

  function stage(raw: Record<string, unknown>, owner: string, tabId: number) {
    const p = normalizeFileParams('files.stage', raw);
    prune();
    const decoded = atob(String(p.data));
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    let file;
    if (typeof p.transferId === 'string') file = get(p.transferId, owner, tabId);
    else {
      const size = Number(p.size);
      if (p.offset !== 0 || bytes.length > size)
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          'First chunk must start at zero and fit declared size.'
        );
      const total = [...files.values()].reduce((sum, value) => sum + value.bytes.length, 0);
      if (files.size >= 16 || total + size > FILE_TOTAL_BYTES || size > FILE_MAX_BYTES)
        throw new BridgeError(
          ERROR_CODES.ARTIFACT_QUOTA_EXCEEDED,
          'Staged file quota exceeded. Release unused files.'
        );
      const id = `file_${crypto.randomUUID()}`;
      file = {
        id,
        owner,
        tabId,
        name: String(p.name),
        mimeType: String(p.mimeType),
        bytes: new Uint8Array(size),
        offset: 0,
        expiresAt: now() + FILE_TTL_MS,
      };
      files.set(id, file);
      const timer = setTimeout(() => discard(id), FILE_TTL_MS);
      timer.unref?.();
      timers.set(id, timer);
    }
    const offset = Number(p.offset);
    if (offset !== file.offset || offset + bytes.length > file.bytes.length)
      throw new BridgeError(
        ERROR_CODES.INVALID_REQUEST,
        'Chunk offset or length does not match staged file.',
        { expectedOffset: file.offset }
      );
    file.bytes.set(bytes, offset);
    file.offset += bytes.length;
    return {
      transferId: file.id,
      nextOffset: file.offset,
      size: file.bytes.length,
      complete: file.offset === file.bytes.length,
      expiresAt: new Date(file.expiresAt).toISOString(),
    };
  }

  function resolve(ids: string[], owner: string, tabId: number) {
    const resolved = ids.map((id) => {
      const file = get(id, owner, tabId);
      if (file.offset !== file.bytes.length)
        throw new BridgeError(
          ERROR_CODES.INVALID_REQUEST,
          'Finish staging the file before assigning it.'
        );
      return file;
    });
    if (resolved.reduce((sum, file) => sum + file.bytes.length, 0) > FILE_TOTAL_BYTES)
      throw new BridgeError(ERROR_CODES.ARTIFACT_QUOTA_EXCEEDED, 'Assignment exceeds 32 MiB.');
    return resolved;
  }

  function release(id: string, owner: string, tabId: number) {
    get(id, owner, tabId);
    discard(id);
    return { released: true };
  }

  function clearTab(tabId: number) {
    for (const [id, file] of files) if (file.tabId === tabId) discard(id);
  }
  function clearAll() {
    for (const id of files.keys()) discard(id);
  }

  function clearTransportOwner(ownerId: string) {
    for (const [id, file] of files) if (file.owner.includes(`:${ownerId}:`)) discard(id);
  }
  return { stage, resolve, release, clearTab, clearAll, clearTransportOwner };
}

/** Executed in the isolated world with BBX's existing locator and reference registries. */
export function assignStagedFiles(
  target: Record<string, unknown>,
  files: Array<{ name: string; mimeType: string; data: string }>
): { assigned: boolean; count: number; totalBytes: number } | { error: string } {
  try {
    const modules = globalThis as typeof globalThis & {
      __BBX_CONTENT_REGISTRY__?: { resolveTarget: (target: Record<string, unknown>) => Element };
      __BBX_CONTENT_DOM_QUERY__?: {
        isLocator: (target: unknown) => boolean;
        locateElements: (
          target: Record<string, unknown>,
          options: Record<string, unknown>
        ) => { matches: Element[]; truncationReason: string | null };
      };
    };
    const query = modules.__BBX_CONTENT_DOM_QUERY__;
    let element;
    if (query && (query.isLocator(target) || typeof target.selector === 'string')) {
      const nth = typeof target.nth === 'number' ? target.nth : null;
      const found = query.locateElements(
        { ...target, includeHidden: true },
        { maxResults: nth === null ? 2 : nth + 1, scanLimit: 5000 }
      );
      if (
        nth === null
          ? found.matches.length !== 1 || found.truncationReason
          : !found.matches[nth] || found.truncationReason === 'scanLimit'
      )
        throw new Error('File target must resolve to exactly one element.');
      element = found.matches[nth ?? 0];
    } else if (typeof target.elementRef === 'string')
      element = modules.__BBX_CONTENT_REGISTRY__?.resolveTarget(target);
    else throw new Error('File locator module is unavailable.');
    if (!(element instanceof HTMLInputElement) || element.type !== 'file')
      throw new Error('Target must be an input[type=file].');
    if (!element.isConnected || element.disabled || element.matches(':disabled'))
      throw new Error('File input is detached or disabled.');
    if (files.length > 1 && !element.multiple)
      throw new Error('File input does not accept multiple files.');
    const transfer = new DataTransfer();
    let totalBytes = 0;
    for (const file of files) {
      const bytes = Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0));
      totalBytes += bytes.length;
      transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
    }
    element.files = transfer.files;
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return {
      assigned: element.files.length === files.length,
      count: element.files.length,
      totalBytes,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function fileBase64(bytes: Uint8Array): string {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 32768)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(''));
}

export async function assignBrowserFiles(
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  selector: string,
  paths: string[]
) {
  const document = (await send('DOM.getDocument', { depth: 0 })) as { root: { nodeId: number } };
  const queried = (await send('DOM.querySelectorAll', {
    nodeId: document.root.nodeId,
    selector,
  })) as { nodeIds: number[] };
  if (queried.nodeIds.length !== 1)
    throw new BridgeError(
      ERROR_CODES.ELEMENT_AMBIGUOUS,
      'File selector must match exactly one input in the top document.'
    );
  const nodeId = queried.nodeIds[0];
  const group = `bbx-files-${crypto.randomUUID()}`;
  try {
    const resolved = (await send('DOM.resolveNode', { nodeId, objectGroup: group })) as {
      object: { objectId: string };
    };
    const checked = (await send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration:
        'function(count) { return this.isConnected && this.tagName === "INPUT" && this.type === "file" && !this.matches(":disabled") && (count <= 1 || this.multiple); }',
      arguments: [{ value: paths.length }],
      returnByValue: true,
    })) as { result: { value?: boolean } };
    if (checked.result.value !== true)
      throw new BridgeError(
        ERROR_CODES.INPUT_INVALID_TARGET,
        'Target must be an enabled file input accepting the supplied number of files.'
      );
    await send('DOM.setFileInputFiles', { nodeId, files: paths });
    const result = (await send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: 'function() { return this.files.length; }',
      returnByValue: true,
    })) as { result: { value?: number } };
    return {
      assigned: result.result.value === paths.length,
      count: result.result.value ?? 0,
      source: 'browser_paths',
    };
  } finally {
    await send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
}
