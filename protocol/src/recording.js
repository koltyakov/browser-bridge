// @ts-check

import { booleanParam, invalidWorkflow, numberParam, onlyKeys, stringParam } from './emulation.js';

/** @param {string} method @param {Record<string, unknown>} params @returns {Record<string, unknown>} */
export function normalizeRecording(method, params) {
  if (method === 'session.journal_read' || method === 'session.journal_delete') {
    onlyKeys(params, [
      'journalId',
      ...(method === 'session.journal_read' ? ['offset', 'maxBytes'] : []),
    ]);
    const journalId = stringParam(params.journalId, 'journalId', 80);
    if (!/^journal_[a-f0-9]{64}$/u.test(journalId)) invalidWorkflow('Invalid journal capability.');
    if (method === 'session.journal_delete') return { journalId };
    const offset = numberParam(params.offset ?? 0, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = numberParam(params.maxBytes ?? 196608, 'maxBytes', 1, 196608);
    if (!Number.isInteger(offset) || !Number.isInteger(maxBytes))
      invalidWorkflow('Journal ranges must be integers.');
    return { journalId, offset, maxBytes };
  }
  if (method === 'session.start') {
    onlyKeys(params, [
      'activity',
      'network',
      'bodies',
      'messages',
      'visual',
      'durationMs',
      'followTabs',
      'durable',
      'replay',
    ]);
    const activity = booleanParam(params.activity ?? true, 'activity');
    const network = booleanParam(params.network ?? false, 'network');
    const bodies = booleanParam(params.bodies ?? false, 'bodies');
    const messages = booleanParam(params.messages ?? false, 'messages');
    const visual = booleanParam(params.visual ?? false, 'visual');
    if ((bodies || messages) && !network) invalidWorkflow('bodies/messages require network:true.');
    if (!activity && !network && !visual && params.replay !== true)
      invalidWorkflow('Enable at least one recording source.');
    return {
      activity,
      network,
      bodies,
      messages,
      visual,
      followTabs: booleanParam(params.followTabs ?? false, 'followTabs'),
      durable: booleanParam(params.durable ?? false, 'durable'),
      replay: booleanParam(params.replay ?? false, 'replay'),
      durationMs: numberParam(params.durationMs ?? 60000, 'durationMs', 1000, 1800000),
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
