// @ts-check

import { invalidWorkflow, numberParam, objectParam, onlyKeys, stringParam } from './emulation.js';

export const FILE_MAX_BYTES = 16 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 192 * 1024;
export const FILE_TOTAL_BYTES = 32 * 1024 * 1024;
export const FILE_TTL_MS = 5 * 60 * 1000;

/** @param {string} method @param {Record<string, unknown>} params @returns {Record<string, unknown>} */
export function normalizeFileParams(method, params) {
  if (method === 'files.stage') {
    onlyKeys(params, ['transferId', 'name', 'mimeType', 'size', 'offset', 'data']);
    /** @type {Record<string, unknown>} */
    const result = {};
    if (params.transferId !== undefined)
      result.transferId = stringParam(params.transferId, 'transferId', 80);
    else {
      result.name = stringParam(params.name, 'name');
      if (/[\\/]/u.test(String(result.name)))
        invalidWorkflow('name must be a filename, not a path.');
      result.mimeType = stringParam(params.mimeType ?? 'application/octet-stream', 'mimeType', 120);
      result.size = numberParam(params.size, 'size', 0, FILE_MAX_BYTES);
      if (!Number.isInteger(result.size)) invalidWorkflow('size must be an integer.');
    }
    result.offset = numberParam(params.offset ?? 0, 'offset', 0, FILE_MAX_BYTES);
    if (!Number.isInteger(result.offset)) invalidWorkflow('offset must be an integer.');
    const data = params.data ?? '';
    if (
      typeof data !== 'string' ||
      data.length > (FILE_CHUNK_BYTES * 4) / 3 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)
    )
      invalidWorkflow('data must be base64, at most 192 KiB decoded per chunk.');
    result.data = data;
    return result;
  }
  if (method === 'files.release') {
    onlyKeys(params, ['transferId']);
    return { transferId: stringParam(params.transferId, 'transferId', 80) };
  }
  if (method === 'input.set_files') {
    onlyKeys(params, ['target', 'files', 'paths']);
    const target = objectParam(params.target, 'target');
    const files = params.files;
    const paths = params.paths;
    if (paths !== undefined) onlyKeys(target, ['selector']);
    if ((files === undefined) === (paths === undefined))
      invalidWorkflow('Provide files or paths, not both. Empty files clears the input.');
    const values = files ?? paths;
    if (!Array.isArray(values) || values.length > 10)
      invalidWorkflow('files/paths must be an array of at most 10 strings.');
    const normalized = values.map((value) =>
      stringParam(
        value,
        files !== undefined ? 'file handle' : 'browser path',
        files !== undefined ? 80 : 4096
      )
    );
    if (
      paths !== undefined &&
      normalized.some((value) => !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(value))
    )
      invalidWorkflow('paths must be absolute paths on the browser machine.');
    if (paths !== undefined && (typeof target.selector !== 'string' || !target.selector))
      invalidWorkflow('Browser-local paths require target.selector in the top document.');
    return { target, ...(files !== undefined ? { files: normalized } : { paths: normalized }) };
  }
  if (method === 'download.resource') {
    onlyKeys(params, ['url', 'maxBytes', 'timeoutMs']);
    const url = stringParam(params.url, 'url', 8192);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      invalidWorkflow('Invalid download URL.');
    }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
      invalidWorkflow('Downloads require HTTP(S) without URL credentials.');
    return {
      url,
      maxBytes: numberParam(params.maxBytes ?? 8 * 1024 * 1024, 'maxBytes', 1, FILE_MAX_BYTES),
      timeoutMs: numberParam(params.timeoutMs ?? 30000, 'timeoutMs', 100, 60000),
    };
  }
  return invalidWorkflow('Unknown file method.');
}
