// @ts-check

import { open } from 'node:fs/promises';
import path from 'node:path';
import { FILE_CHUNK_BYTES, FILE_MAX_BYTES, FILE_TOTAL_BYTES } from '../../protocol/src/files.js';

/** Upload agent-local files through bounded chunks, then assign them once. No byte payload enters output.
 * @param {(method: import('../../protocol/src/types.js').BridgeMethod, params: Record<string, unknown>) => Promise<import('../../protocol/src/types.js').BridgeResponse>} call
 * @param {Record<string, unknown>} target
 * @param {string[]} paths
 * @param {'input.set_files' | 'input.paste_image'} [action]
 */
export async function uploadFiles(call, target, paths, action = 'input.set_files') {
  if (action === 'input.paste_image' && paths.length !== 1)
    throw new Error('Paste requires exactly one PNG.');
  if (!paths.length || paths.length > 10) throw new Error('Provide 1..10 local files.');
  /** @type {Array<{ file: import('node:fs/promises').FileHandle, name: string, size: number }>} */
  const opened = [];
  /** @type {string[]} */
  const handles = [];
  try {
    for (const filename of paths) {
      const file = await open(filename, 'r');
      opened.push({ file, name: path.basename(filename), size: 0 });
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > FILE_MAX_BYTES)
        throw new Error('Each upload must be a regular file of at most 16 MiB.');
      opened[opened.length - 1].size = stat.size;
    }
    if (opened.reduce((sum, item) => sum + item.size, 0) > FILE_TOTAL_BYTES)
      throw new Error('Combined upload size exceeds 32 MiB.');
    for (const { file, name, size } of opened) {
      let offset = 0;
      let transferId;
      do {
        const buffer = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, size - offset));
        let used = 0;
        while (used < buffer.length) {
          const { bytesRead } = await file.read(buffer, used, buffer.length - used, offset + used);
          if (!bytesRead) throw new Error('Upload file changed while reading.');
          used += bytesRead;
        }
        const response = await call('files.stage', {
          ...(transferId ? { transferId } : { name, mimeType: mimeForName(name), size }),
          offset,
          data: buffer.toString('base64'),
        });
        if (!response.ok) throw new Error(response.error.message);
        const result = /** @type {{ transferId: string, nextOffset: number }} */ (response.result);
        if (!transferId) {
          transferId = result.transferId;
          handles.push(transferId);
        }
        if (result.transferId !== transferId || result.nextOffset !== offset + used)
          throw new Error('Invalid file staging acknowledgement.');
        offset = result.nextOffset;
      } while (offset < size);
    }
    return await call(
      action,
      action === 'input.paste_image'
        ? { target, transferId: handles[0] }
        : { target, files: handles }
    );
  } finally {
    await Promise.allSettled(opened.map(({ file }) => file.close()));
    await Promise.allSettled(handles.map((transferId) => call('files.release', { transferId })));
  }
}

/** @param {string} name */
function mimeForName(name) {
  /** @type {Record<string, string>} */
  const types = {
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.html': 'text/html',
    '.zip': 'application/zip',
  };
  return types[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}
