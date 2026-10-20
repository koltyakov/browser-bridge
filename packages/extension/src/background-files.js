// @ts-check

import { BridgeError, ERROR_CODES } from '../../protocol/src/index.js';
import {
  FILE_MAX_BYTES,
  FILE_TOTAL_BYTES,
  FILE_TTL_MS,
  normalizeFileParams,
} from '../../protocol/src/files.js';

/** @typedef {{ id: string, owner: string, tabId: number, name: string, mimeType: string, bytes: Uint8Array, offset: number, expiresAt: number }} StagedFile */

/** Chunked input keeps file bytes out of model responses and works across remote destinations.
 * @param {{ now?: () => number }} [deps] */
export function createFileStaging(deps = {}) {
  const now = deps.now ?? Date.now;
  /** @type {Map<string, StagedFile>} */
  const files = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** @param {string} id */
  function discard(id) {
    files.delete(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
  }
  function prune() {
    for (const [id, file] of files) if (file.expiresAt <= now()) discard(id);
  }
  /** @param {string} id @param {string} owner @param {number} tabId */
  function get(id, owner, tabId) {
    prune();
    const file = files.get(id);
    if (!file || file.owner !== owner || file.tabId !== tabId)
      throw new BridgeError(
        ERROR_CODES.ARTIFACT_NOT_FOUND,
        'Staged file expired or belongs to another tab/session. Stage it again.'
      );
    return file;
  }
  /** @param {Record<string, unknown>} raw @param {string} owner @param {number} tabId */
  function stage(raw, owner, tabId) {
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
  /** @param {string[]} ids @param {string} owner @param {number} tabId */
  function resolve(ids, owner, tabId) {
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
  /** @param {string} id @param {string} owner @param {number} tabId */
  function release(id, owner, tabId) {
    get(id, owner, tabId);
    discard(id);
    return { released: true };
  }
  /** @param {number} tabId */
  function clearTab(tabId) {
    for (const [id, file] of files) if (file.tabId === tabId) discard(id);
  }
  function clearAll() {
    for (const id of files.keys()) discard(id);
  }
  return { stage, resolve, release, clearTab, clearAll };
}

/** Executed in the isolated world with BBX's existing locator and reference registries.
 * @param {Record<string, unknown>} target
 * @param {Array<{ name: string, mimeType: string, data: string }>} files
 * @returns {{ assigned: boolean, count: number, totalBytes: number } | { error: string }} */
export function assignStagedFiles(target, files) {
  try {
    const modules =
      /** @type {typeof globalThis & {
       * __BBX_CONTENT_REGISTRY__?: { resolveTarget: (target: Record<string, unknown>) => Element },
       * __BBX_CONTENT_DOM_QUERY__?: { isLocator: (target: unknown) => boolean, locateElements: (target: Record<string, unknown>, options: Record<string, unknown>) => { matches: Element[], truncationReason: string | null } }
       * }} */ (globalThis);
    const query = modules.__BBX_CONTENT_DOM_QUERY__;
    let element;
    if (query?.isLocator(target)) {
      const found = query.locateElements(
        { ...target, includeHidden: true },
        { maxResults: 2, scanLimit: 5000 }
      );
      if (found.matches.length !== 1 || found.truncationReason)
        throw new Error('File target must resolve to exactly one element.');
      element = found.matches[0];
    } else element = modules.__BBX_CONTENT_REGISTRY__?.resolveTarget(target);
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

/** @param {Uint8Array} bytes @returns {string} */
export function fileBase64(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 32768)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(''));
}

/** @param {(method: string, params: Record<string, unknown>) => Promise<unknown>} send @param {string} selector @param {string[]} paths */
export async function assignBrowserFiles(send, selector, paths) {
  const document = /** @type {{ root: { nodeId: number } }} */ (
    await send('DOM.getDocument', { depth: 0 })
  );
  const queried = /** @type {{ nodeIds: number[] }} */ (
    await send('DOM.querySelectorAll', { nodeId: document.root.nodeId, selector })
  );
  if (queried.nodeIds.length !== 1)
    throw new BridgeError(
      ERROR_CODES.ELEMENT_AMBIGUOUS,
      'File selector must match exactly one input in the top document.'
    );
  const nodeId = queried.nodeIds[0];
  const group = `bbx-files-${crypto.randomUUID()}`;
  try {
    const resolved = /** @type {{ object: { objectId: string } }} */ (
      await send('DOM.resolveNode', { nodeId, objectGroup: group })
    );
    const checked = /** @type {{ result: { value?: boolean } }} */ (
      await send('Runtime.callFunctionOn', {
        objectId: resolved.object.objectId,
        functionDeclaration:
          'function(count) { return this.isConnected && this.tagName === "INPUT" && this.type === "file" && !this.matches(":disabled") && (count <= 1 || this.multiple); }',
        arguments: [{ value: paths.length }],
        returnByValue: true,
      })
    );
    if (checked.result.value !== true)
      throw new BridgeError(
        ERROR_CODES.INPUT_INVALID_TARGET,
        'Target must be an enabled file input accepting the supplied number of files.'
      );
    await send('DOM.setFileInputFiles', { nodeId, files: paths });
    const result = /** @type {{ result: { value?: number } }} */ (
      await send('Runtime.callFunctionOn', {
        objectId: resolved.object.objectId,
        functionDeclaration: 'function() { return this.files.length; }',
        returnByValue: true,
      })
    );
    return {
      assigned: result.result.value === paths.length,
      count: result.result.value ?? 0,
      source: 'browser_paths',
    };
  } finally {
    await send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
}
