import { BridgeError, ERROR_CODES } from './errors.js';

export function normalizeAccessWaitForChangeParams(
  params: Record<string, unknown> = {}
): import('./types.js').NormalizedAccessWaitForChangeParams {
  if (
    Object.keys(params).some((key) => key !== 'revision' && key !== 'timeoutMs') ||
    typeof params.revision !== 'string' ||
    !params.revision ||
    params.revision.length > 128
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'revision must be a non-empty settings revision of at most 128 characters.'
    );
  }
  const timeoutMs = params.timeoutMs ?? 25_000;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 25_000
  ) {
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'timeoutMs must be an integer between 0 and 25000.'
    );
  }
  return { revision: params.revision, timeoutMs };
}
