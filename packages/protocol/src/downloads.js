// @ts-check
import { booleanParam, invalidWorkflow, onlyKeys, stringParam } from './emulation.js';

/** @param {string} method @param {Record<string, unknown>} params */
export function normalizeDownload(method, params) {
  if (method !== 'download.start') {
    onlyKeys(params, ['downloadId']);
    return { downloadId: stringParam(params.downloadId, 'downloadId', 100) };
  }
  onlyKeys(params, ['url', 'filename', 'saveAs']);
  const url = stringParam(params.url, 'url', 8192);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return invalidWorkflow('Invalid download URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    invalidWorkflow('Downloads require HTTP(S) without URL credentials.');
  const filename =
    params.filename === undefined ? undefined : stringParam(params.filename, 'filename', 240);
  if (
    filename &&
    (/[\\/:]/u.test(filename) ||
      [...filename].some((character) => character.charCodeAt(0) < 32) ||
      filename === '.' ||
      filename === '..')
  )
    invalidWorkflow('filename must be a single filename, not a path.');
  return {
    url,
    ...(filename ? { filename } : {}),
    saveAs: booleanParam(params.saveAs ?? false, 'saveAs'),
  };
}
