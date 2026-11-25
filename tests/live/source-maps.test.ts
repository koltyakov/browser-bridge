import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { runCli } from '../_helpers/runCli.ts';

// Opt-in: make test-sourcemaps-live with BBX_LIVE_EXTENSION_ID set to a profile
// whose window access is already enabled. Serves the checked-in minified
// fixture bundle from 127.0.0.1, opens it in a background tab, makes it throw,
// and checks that `bbx console exception --resolve` names the original file.
// No access or focus setting is changed; the tab is closed afterwards.
test('bbx console --resolve reports the original file and line', { timeout: 60_000 }, async () => {
  const extensionId = process.env.BBX_LIVE_EXTENSION_ID;
  assert(extensionId, 'Set BBX_LIVE_EXTENSION_ID.');
  const fixtures = new URL('../fixtures/source-maps/generated/', import.meta.url);
  const files: Record<string, { type: string; body: string }> = {
    '/': {
      type: 'text/html',
      body: [
        '<!doctype html><title>BBX source map fixture</title>',
        '<script src="/assets/external.js"></script>',
        '<button id="fail" onclick="setTimeout(() => alphaSubmit(\'order-1\', -1))">Fail</button>',
      ].join('\n'),
    },
    '/assets/external.js': {
      type: 'text/javascript',
      body: await readFile(new URL('external.js', fixtures), 'utf8'),
    },
    '/assets/external.js.map': {
      type: 'application/json',
      body: await readFile(new URL('external.js.map', fixtures), 'utf8'),
    },
  };
  const requested: string[] = [];
  const server = createServer((request, response) => {
    const file = files[request.url ?? ''];
    requested.push(request.url ?? '');
    response.writeHead(file ? 200 : 404, {
      'content-type': file?.type ?? 'text/plain',
      'cache-control': 'no-store',
    });
    response.end(file?.body ?? 'missing');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  // Flags follow the command name, as in `bbx call --tab 5 METHOD`.
  async function bbx(command: string, ...args: string[]) {
    const result = await runCli({
      args: [command, '--extension', extensionId as string, ...args],
      env: { ...process.env, BBX_REMOTE: '', BBX_AUTO_UPDATE: 'off' },
    });
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(' ')}: ${result.stderr}${result.stdout}`
    );
    return result.stdout;
  }

  let tabId = 0;
  try {
    const created = await bbx(
      'call',
      'tabs.create',
      JSON.stringify({ url: `${origin}/`, active: false })
    );
    const match = /"tabId"\s*:\s*(\d+)/u.exec(created);
    assert(match, created);
    tabId = Number(match[1]);
    const tab = ['--tab', String(tabId)];
    await bbx('call', ...tab, 'page.wait_for_load_state', JSON.stringify({ timeoutMs: 10_000 }));
    await bbx('call', ...tab, 'page.get_console', JSON.stringify({ clear: true }));
    await bbx('call', ...tab, 'input.click', JSON.stringify({ target: { selector: '#fail' } }));
    await delay(250);

    const plain = await bbx('console', ...tab, 'exception');
    assert.match(plain, /assets\/external\.js:1:\d+/u);
    assert.equal(requested.filter((url) => url.endsWith('.map')).length, 0);

    const resolved = await bbx('console', ...tab, 'exception', '--resolve');
    assert.match(resolved, /src\/alpha\.ts:6:5/u);
    assert.equal(resolved.includes('SOURCES_CONTENT_CANARY'), false);
    assert.equal(requested.filter((url) => url === '/assets/external.js.map').length, 1);
  } finally {
    if (tabId) await bbx('call', 'tabs.close', JSON.stringify({ tabId })).catch(() => {});
    server.close();
  }
});
