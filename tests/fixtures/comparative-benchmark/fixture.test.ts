import assert from 'node:assert/strict';
import test from 'node:test';
import { Fixture } from './fixture.ts';
import { selectTasks } from './tasks.ts';

test('fixture uses two real origins, a compiled classic script, and no HTTP oracle', async (t) => {
  const fixture = new Fixture(selectTasks(['frame-cross'])[0], 4);
  t.after(() => fixture.close());
  await fixture.start();
  const response = await fetch(fixture.url);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Main profile/);
  const frame = /<iframe title="Payment" src="([^"]+)"/.exec(html)![1];
  assert.notEqual(new URL(frame).origin, new URL(fixture.url).origin);
  assert.match(await (await fetch(frame)).text(), /payment-profile/);
  assert.match(await (await fetch(new URL('/app.js', fixture.url))).text(), /benchmark-replace/);
  assert.equal((await fetch(new URL('/oracle', fixture.url))).status, 404);
  assert.equal((await fetch(new URL('/reset', fixture.url))).status, 404);
  assert.equal((await fetch(fixture.url, { method: 'POST' })).status, 405);
  assert.equal(fixture.effects.length, 0);
});

test('fixture records every attempt/commit, preserves wrong values, and does not deduplicate', async (t) => {
  const fixture = new Fixture(selectTasks(['save'])[0], 3);
  t.after(() => fixture.close());
  await fixture.start();
  fixture.begin();
  const abort = new AbortController();
  const waiting = fixture.waitForCommit('save', 'main', abort.signal);
  for (const value of ['wrong', 'ada@example.test', 'ada@example.test']) {
    const response = await fetch(new URL('/effect', fixture.url), {
      method: 'POST',
      body: JSON.stringify({ operation: 'save', record: 'main', value }),
    });
    assert.equal(response.status, 200);
  }
  await waiting;
  await fixture.waitForCommit('save', 'main', abort.signal);
  assert.equal(fixture.effects.length, 6);
  assert.deepEqual(
    fixture.effects.map((effect) => effect.sequence),
    [1, 2, 3, 4, 5, 6]
  );
  assert.equal(typeof fixture.goalAtMs(), 'number');
  await fetch(fixture.url);
  assert.equal(fixture.effects.at(-1)?.operation, 'document_reload');
  const measured = fixture.effects.length;
  fixture.end();
  await fetch(new URL('/effect', fixture.url), {
    method: 'POST',
    body: JSON.stringify({ operation: 'dismissed', record: 'main', value: '' }),
  });
  assert.equal(
    fixture.effects.length,
    measured,
    'Teardown effects belong outside the task audit window'
  );
});

test('invalid writes cannot create effects and waits respect abort and close', async (t) => {
  const fixture = new Fixture(selectTasks(['save'])[0], 1);
  t.after(() => fixture.close());
  await fixture.start();
  fixture.begin();
  assert.equal(fixture.goalAtMs(), null);
  for (const body of [
    'bad json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ operation: 3, record: 'main', value: '' }),
  ]) {
    assert.equal(
      (await fetch(new URL('/effect', fixture.url), { method: 'POST', body })).status,
      400
    );
  }
  assert.equal(
    (await fetch(new URL('/effect', fixture.url), { method: 'POST', body: 'x'.repeat(5000) }))
      .status,
    413
  );
  assert.equal(fixture.effects.length, 0);
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(fixture.waitForCommit('save', 'main', canceled.signal), /canceled/);
  const pending = new AbortController();
  const waiting = fixture.waitForCommit('save', 'main', pending.signal);
  pending.abort();
  await assert.rejects(waiting, /canceled/);
  const closing = fixture.waitForCommit('save', 'main', new AbortController().signal);
  await fixture.close();
  await assert.rejects(closing, /canceled/);
});

test('lost-result fixture commits before releasing its application response', async (t) => {
  const fixture = new Fixture(selectTasks(['disconnect-after-commit'])[0], 1);
  t.after(() => fixture.close());
  await fixture.start();
  fixture.begin();
  let delivered = false;
  const response = fetch(new URL('/effect', fixture.url), {
    method: 'POST',
    body: JSON.stringify({ operation: 'save', record: 'main', value: 'ada@example.test' }),
  }).then((result) => {
    delivered = true;
    return result;
  });
  await fixture.waitForCommit('save', 'main', new AbortController().signal);
  assert.equal(fixture.effects.filter((effect) => effect.phase === 'commit').length, 1);
  assert.equal(delivered, false);
  fixture.releaseReply();
  assert.equal((await response).status, 200);
});
