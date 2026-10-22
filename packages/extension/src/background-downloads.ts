import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';

export type OwnedDownload = { id: number; tabId: number; scope: string; createdAt: number };

/** Browser-managed downloads never pass file bytes through native messaging.
Opaque capabilities allow separate CLI invocations to control only BBX-created downloads. */
export function createDownloadController(deps: {
  downloads: typeof chrome.downloads;
  storage: chrome.storage.StorageArea;
}) {
  /** Serialize storage updates and limit concurrent starts. */
  let queue: Promise<unknown> = Promise.resolve();

  function locked<T>(task: () => Promise<T>): Promise<T> {
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending;
  }

  async function load(): Promise<Record<string, OwnedDownload>> {
    const stored = await deps.storage.get('bbxDownloads');
    return (stored.bbxDownloads ?? {}) as Record<string, OwnedDownload>;
  }

  async function save(records: Record<string, OwnedDownload>) {
    await deps.storage.set({ bbxDownloads: records });
  }

  function summary(item: chrome.downloads.DownloadItem, downloadId: string) {
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

  function call(
    method: string,
    params: Record<string, unknown>,
    tabId: number,
    scope: string,
    assertAccess: () => Promise<void>
  ) {
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

  function clear(tabId?: number) {
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
