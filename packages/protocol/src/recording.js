// @ts-check

import { booleanParam, invalidWorkflow, numberParam, onlyKeys, stringParam } from './emulation.js';

/** @param {string} method @param {Record<string, unknown>} params @returns {Record<string, unknown>} */
export function normalizeRecording(method, params) {
  if (method === 'session.start') {
    onlyKeys(params, ['activity', 'network', 'bodies', 'messages', 'visual', 'durationMs']);
    const activity = booleanParam(params.activity ?? true, 'activity');
    const network = booleanParam(params.network ?? false, 'network');
    const bodies = booleanParam(params.bodies ?? false, 'bodies');
    const messages = booleanParam(params.messages ?? false, 'messages');
    const visual = booleanParam(params.visual ?? false, 'visual');
    if ((bodies || messages) && !network) invalidWorkflow('bodies/messages require network:true.');
    if (!activity && !network && !visual) invalidWorkflow('Enable at least one recording source.');
    return {
      activity,
      network,
      bodies,
      messages,
      visual,
      durationMs: numberParam(params.durationMs ?? 60000, 'durationMs', 1000, 300000),
    };
  }
  onlyKeys(params, [
    'sessionId',
    ...(method === 'session.read' ? ['cursor', 'limit', 'waitMs'] : []),
    ...(method === 'session.export' ? ['format'] : []),
  ]);
  const sessionId = stringParam(params.sessionId, 'sessionId', 80);
  if (method === 'session.export') {
    if (params.format !== undefined && params.format !== 'json' && params.format !== 'html')
      invalidWorkflow('format must be json or html.');
    return { sessionId, format: params.format ?? 'json' };
  }
  if (method !== 'session.read') return { sessionId };
  const cursor = numberParam(params.cursor ?? 0, 'cursor', 0, Number.MAX_SAFE_INTEGER);
  const limit = numberParam(params.limit ?? 25, 'limit', 1, 100);
  if (!Number.isInteger(cursor) || !Number.isInteger(limit))
    invalidWorkflow('cursor and limit must be integers.');
  return { sessionId, cursor, limit, waitMs: numberParam(params.waitMs ?? 0, 'waitMs', 0, 25000) };
}
