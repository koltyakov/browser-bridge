import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordingStore } from '../src/recording-store.js';
import { parseRecordingJournal, renderReplay } from '../../protocol/src/replay.js';

test('acknowledged journal bytes survive restart, reject foreign writers and preserve partial-tail gaps', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-journal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new RecordingStore(directory);
  const { journalId } = store.begin('extension-a');
  const text =
    JSON.stringify({ kind: 'event', event: { type: 'click', at: 1 } }) + '\n' + '{"kind":';
  const encoded = Buffer.from(text).toString('base64');
  assert.throws(() => store.append(journalId, 'extension-b', 0, encoded), /connection/);
  assert.equal(
    store.append(journalId, 'extension-a', 0, encoded).nextOffset,
    Buffer.byteLength(text)
  );
  assert.throws(() => store.append(journalId, 'extension-a', 0, encoded), /offset/);
  store.disconnect('extension-a');
  assert.throws(
    () => store.append(journalId, 'extension-a', Buffer.byteLength(text), encoded),
    /connection/
  );
  const restarted = new RecordingStore(directory);
  const first = restarted.read(journalId, 0, 8);
  const second = restarted.read(journalId, 8, 196608);
  const recovered = Buffer.concat([
    Buffer.from(first.data, 'base64'),
    Buffer.from(second.data, 'base64'),
  ]).toString();
  assert.equal(recovered, text);
  const replay = parseRecordingJournal(recovered);
  assert.equal(replay.events.length, 1);
  assert.equal(replay.gaps, 2);
  assert.throws(() => restarted.read('../outside', 0, 1), /Unknown/);
  assert.throws(() => restarted.read(journalId, -1, 1), /range/);
  assert.deepEqual(restarted.delete(journalId), { deleted: true });
  assert.throws(() => restarted.read(journalId, 0, 1));
});

test(
  'journal refuses symlink reads and expires stale evidence',
  { skip: process.platform === 'win32' },
  (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-journal-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new RecordingStore(directory);
    const { journalId } = store.begin('extension');
    const filename = store.filename(journalId);
    fs.utimesSync(filename, 0, 0);
    assert.throws(() => store.read(journalId, 0, 1));
    const other = path.join(directory, 'private');
    fs.writeFileSync(other, 'secret');
    fs.symlinkSync(other, filename);
    assert.throws(() => store.read(journalId, 0, 196608));
  }
);

test('interactive renderer replay treats site data as inert JSON and blocks external resources', () => {
  const untrusted = JSON.parse(
    '{"frames":[],"events":[],"gaps":"<script>evil()</script>","dropped":"<img src=https://evil>"}'
  ) as Parameters<typeof renderReplay>[0];
  assert.doesNotMatch(renderReplay(untrusted), /<script>evil|<img src=https/);
  const html = renderReplay({
    frames: [
      { at: 1, data: 'YQ==' },
      { at: 2, data: 'bad"><img src=https://evil>' },
    ],
    events: [{ type: '</script><script>evil()</script>' }],
    gaps: 1,
    dropped: 0,
  });
  assert.doesNotMatch(html, /<script>evil|<img src=https/);
  assert.match(html, /\\u003c\/script>/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-/);
  assert.match(html, /requestAnimationFrame/);
});
