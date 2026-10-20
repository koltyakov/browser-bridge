import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSession } from '../src/record-session.js';
import { createSuccess } from '../../protocol/src/index.js';

test('recording CLI retains one lifecycle, saves only the final artifact, and releases on save failure', async () => {
  const calls: string[] = [];
  let reads = 0;
  let announced = false;
  await assert.rejects(
    recordSession(
      async (method) => {
        calls.push(method);
        if (method === 'session.start')
          return createSuccess('id', { sessionId: 'recording', nextCursor: 1 });
        if (method === 'session.read')
          return createSuccess('id', { active: reads++ === 0, nextCursor: 2 });
        if (method === 'session.export')
          return createSuccess('id', { artifact: { artifactId: 'artifact' }, gaps: 0, dropped: 0 });
        return createSuccess('id', { released: true });
      },
      { durationMs: 1000 },
      'json',
      async (artifact) => {
        assert.equal(artifact.artifactId, 'artifact');
        throw new Error('disk full');
      },
      () => {
        announced = true;
      }
    ),
    /disk full/
  );
  assert.equal(announced, true);
  assert.deepEqual(calls, [
    'session.start',
    'session.read',
    'session.read',
    'session.export',
    'session.release',
  ]);
});
