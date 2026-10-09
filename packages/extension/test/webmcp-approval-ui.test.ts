import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withDocument } from '../../../tests/_helpers/dom.ts';

async function render(
  available: boolean,
  body: (messages: Record<string, unknown>[], closed: () => number) => Promise<void>
) {
  const html = await readFile(new URL('../ui/webmcp-approval.html', import.meta.url), 'utf8');
  await withDocument(html, async ({ document, window }) => {
    const saved = Reflect.get(globalThis, 'chrome');
    const messages: Record<string, unknown>[] = [];
    let closes = 0;
    Reflect.set(window, 'close', () => {
      closes++;
    });
    Reflect.set(globalThis, 'location', { hash: '#request-123' });
    Reflect.set(document.getElementById('deny')!, 'focus', () => {});
    Reflect.set(globalThis, 'chrome', {
      runtime: {
        async sendMessage(message: Record<string, unknown>) {
          messages.push(message);
          if (message.type === 'webmcp.approval.get')
            return {
              ok: available,
              details: {
                origin: 'https://example.test',
                tabId: 10,
                tool: {
                  name: '<img src=x onerror=steal()>',
                  description: 'untrusted\u202e',
                  inputSchema: { type: 'object' },
                },
                arguments: { value: '<script>steal()</script>' },
              },
            };
          return { ok: true };
        },
      },
    });
    try {
      await import(
        `${new URL('../ui/webmcp-approval.js', import.meta.url).href}?case=${crypto.randomUUID()}`
      );
      await new Promise((resolve) => setImmediate(resolve));
      await body(messages, () => closes);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(globalThis, 'chrome');
      else Reflect.set(globalThis, 'chrome', saved);
    }
  });
}

test('WebMCP approval renders untrusted content as text and sends only an explicit one-shot decision', async () => {
  await render(true, async (messages, closed) => {
    assert.equal(messages.length, 1);
    assert.equal(document.querySelector('img'), null);
    assert.equal(document.getElementById('tool-name')!.textContent, '<img src=x onerror=steal()>');
    assert.match(document.getElementById('metadata')!.textContent ?? '', /\\u202e/);
    assert.equal(document.querySelector('#arguments script'), null);
    const button = document.getElementById('approve') as HTMLButtonElement;
    assert.equal(button.disabled, false);
    button.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(messages[1], {
      type: 'webmcp.approval.decide',
      id: 'request-123',
      approved: true,
    });
    assert.equal(button.disabled, true);
    assert.equal(closed(), 1);
  });
});

test('WebMCP missing approval stays disabled and decline does not grant permission', async () => {
  await render(false, async (messages) => {
    assert.match(document.getElementById('status')!.textContent ?? '', /expired/);
    assert.equal((document.getElementById('approve') as HTMLButtonElement).disabled, true);
    assert.equal(messages.length, 1);
  });
  await render(true, async (messages) => {
    document.getElementById('deny')!.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages[1].approved, false);
  });
});
