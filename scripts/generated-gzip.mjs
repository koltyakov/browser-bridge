// @ts-check
import fs from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

/** Keep existing valid bytes across Node/zlib versions; compare decoded content.
 * @param {string} filename
 * @param {Uint8Array} content
 * @param {boolean} check
 * @returns {Promise<void>}
 */
export async function generateGzip(filename, content, check) {
  const existing = await fs.readFile(filename).catch(() => Buffer.alloc(0));
  try {
    if (gunzipSync(existing).equals(content)) return;
  } catch {
    // Missing or invalid compressed assets must be regenerated.
  }
  if (check) throw new Error(`Compressed asset is stale: ${filename}. Run make generate-protocol.`);
  const compressed = gzipSync(content, { level: 9 });
  // Normalize the gzip OS header so host-platform metadata cannot change bytes.
  compressed[9] = 255;
  await fs.writeFile(filename, compressed);
}
