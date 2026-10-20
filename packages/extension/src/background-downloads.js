// @ts-check
import { BridgeError, ERROR_CODES } from '../../protocol/src/index.js';

/** @typedef {{ id: number, tabId: number, scope: string, createdAt: number }} OwnedDownload */

/** Browser-managed downloads never pass file bytes through native messaging.
 * Opaque capabilities allow separate CLI invocations to control only BBX-created downloads.
 * @param {{ downloads: typeof chrome.downloads, storage: chrome.storage.StorageArea }} deps */
export function createDownloadController(deps) {
  /** Serialize storage updates and limit concurrent starts. @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  function locked(task) {
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending;
  }
  /** @returns {Promise<Record<string, OwnedDownload>>} */
  async function load() {
    const stored = await deps.storage.get('bbxDownloads');
    return /** @type {Record<string, OwnedDownload>} */ (stored.bbxDownloads ?? {});
  }
  /** @param {Record<string, OwnedDownload>} records */
  async function save(records) {
    await deps.storage.set({ bbxDownloads: records });
  }
  /** @param {chrome.downloads.DownloadItem} item @param {string} downloadId */
  function summary(item, downloadId) {
    return {
      downloadId,
      state: item.state,
      paused: item.paused,
      canResume: item.canResume,
      bytesReceived: item.bytesReceived,
      totalBytes: item.totalBytes,
      fileSize: item.fileSize,
      filename: item.filename,
      exists: item.exists,
      error: item.error ?? null,
      danger: item.danger,
      delivery: 'browser-file',
    };
  }
  /** @param {string} method @param {Record<string, unknown>} params @param {number} tabId @param {string} scope @param {() => Promise<void>} assertAccess */
  function call(method, params, tabId, scope, assertAccess) {
    return locked(async () => {
      await assertAccess();
      const records = await load();
      if (method === 'download.start') {
        // Keep active downloads; prune only expired terminal records.
        for (const [key, record] of Object.entries(records)) {
          if (Date.now() - record.createdAt < 86400000) continue;
          const [item] = await deps.downloads.search({ id: record.id });
          if (!item || item.state !== 'in_progress') delete records[key];
        }
        if (Object.keys(records).length >= 32)
          throw new BridgeError(
            ERROR_CODES.ARTIFACT_QUOTA_EXCEEDED,
            'Release a retained download before starting another.'
          );
        await assertAccess();
        const id = await deps.downloads.download({
          url: String(params.url),
          ...(typeof params.filename === 'string' ? { filename: params.filename } : {}),
          saveAs: params.saveAs === true,
          conflictAction: 'uniquify',
        });
        const downloadId = `download_${crypto.randomUUID()}_${crypto.randomUUID()}`;
        records[downloadId] = { id, tabId, scope, createdAt: Date.now() };
        try {
          await assertAccess();
          await save(records);
        } catch (error) {
          await deps.downloads.cancel(id).catch(() => {});
          throw error;
        }
        const [item] = await deps.downloads.search({ id });
        return item
          ? summary(item, downloadId)
          : { downloadId, state: 'starting', delivery: 'browser-file' };
      }
      const downloadId = String(params.downloadId);
      const owned = Object.hasOwn(records, downloadId) ? records[downloadId] : undefined;
      if (!owned || owned.tabId !== tabId || owned.scope !== scope)
        throw new BridgeError(
          ERROR_CODES.ARTIFACT_NOT_FOUND,
          'Download handle is unknown or outside this tab/access scope.'
        );
      await assertAccess();
      if (method === 'download.pause') await deps.downloads.pause(owned.id);
      else if (method === 'download.resume') await deps.downloads.resume(owned.id);
      else if (method === 'download.cancel') await deps.downloads.cancel(owned.id);
      const [item] = await deps.downloads.search({ id: owned.id });
      if (method === 'download.release') {
        if (item?.state === 'in_progress')
          throw new BridgeError(
            ERROR_CODES.INVALID_REQUEST,
            'Cancel or finish the download before releasing its handle.'
          );
        delete records[downloadId];
        await save(records);
        return { released: true, fileDeleted: false };
      }
      await assertAccess();
      if (!item)
        throw new BridgeError(
          ERROR_CODES.ARTIFACT_NOT_FOUND,
          'Browser download is no longer available.'
        );
      return summary(item, downloadId);
    });
  }
  /** @param {number} [tabId] */
  function clear(tabId) {
    return locked(async () => {
      const records = await load();
      for (const [key, record] of Object.entries(records)) {
        if (tabId !== undefined && record.tabId !== tabId) continue;
        await deps.downloads.cancel(record.id).catch(() => {});
        delete records[key];
      }
      await save(records);
    });
  }
  return { call, clear };
}
