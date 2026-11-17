import assert from 'node:assert/strict';
import test from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { triggerDialog } from './bbx-driver.ts';

test('dialog driver inspects after successful or dialog-blocked clicks without replay', async () => {
  for (const blocked of [false, true]) {
    let clicks = 0;
    await triggerDialog(async () => {
      clicks++;
      return {
        content: [],
        ...(blocked
          ? { isError: true, structuredContent: { ok: false, error: { code: 'DIALOG_BLOCKED' } } }
          : { structuredContent: { ok: true, evidence: {} } }),
      };
    });
    assert.equal(clicks, 1);
  }
});

test('dialog driver does not swallow unrelated errors, transport loss, or malformed replies', async () => {
  for (const response of [
    { content: [], isError: true, structuredContent: { ok: false, error: { code: 'TIMEOUT' } } },
    { content: [], isError: true },
    { content: [], structuredContent: { ok: false } },
  ] satisfies CallToolResult[]) {
    let clicks = 0;
    await assert.rejects(
      triggerDialog(async () => {
        clicks++;
        return response;
      })
    );
    assert.equal(clicks, 1);
  }
  await assert.rejects(
    triggerDialog(() => Promise.reject(new Error('connection lost'))),
    /connection lost/
  );
});
