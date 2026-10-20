import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournalTransport } from '../src/recording-journal.js';

test('journal transport chunks and acknowledges bytes, propagates disk errors, and rejects disconnects', async () => {
  const chunks: Buffer[] = [];
  let offset = 0;
  let fail = false;
  let stall = false;
  const transport = createJournalTransport(
    () =>
      ({
        postMessage(message: Record<string, unknown>) {
          if (stall) return;
          queueMicrotask(() => {
            if (fail) {
              transport.handle({
                type: 'host.journal.ack',
                messageId: message.messageId,
                error: 'Disk full',
              });
              return;
            }
            if (message.type === 'host.journal.append') {
              assert.equal(message.offset, offset);
              const bytes = Buffer.from(String(message.data), 'base64');
              assert.ok(bytes.length <= 196608);
              chunks.push(bytes);
              offset += bytes.length;
            }
            transport.handle({
              type: 'host.journal.ack',
              messageId: message.messageId,
              result: { journalId: 'journal_test', nextOffset: offset },
            });
          });
        },
      }) as unknown as chrome.runtime.Port
  );
  const journal = await transport.begin('request');
  const record = { text: 'é'.repeat(200000) };
  await journal.append(record);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), record);
  assert.ok(chunks.length > 1);
  fail = true;
  await assert.rejects(journal.append({ text: 'next' }), /Disk full/);
  stall = true;
  const pending = journal.append({ text: 'last' });
  transport.disconnect();
  await assert.rejects(pending, /disconnected/);
  assert.equal(transport.handle({ type: 'other' }), false);
});
