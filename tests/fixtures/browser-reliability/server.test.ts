import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import test from 'node:test';

import {
  DEFAULT_FIXTURE_PORT,
  FIXTURE_HOST,
  parseFixturePort,
  startFixtureServer,
} from './server.mjs';

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('fixture port parsing accepts explicit valid ports and rejects unsafe values', () => {
  assert.equal(parseFixturePort(undefined), DEFAULT_FIXTURE_PORT);
  assert.equal(parseFixturePort('4321'), 4321);
  for (const value of ['0', '65536', '-1', '12.5', 'fixture']) {
    assert.throws(() => parseFixturePort(value), /integer from 1 to 65535/u);
  }
});

test('fixture server binds locally and serves static, redirect, cache, slow, and failure routes', async () => {
  const running = await startFixtureServer({ port: 0 });
  try {
    const address = running.server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, FIXTURE_HOST);
    assert.equal(running.origin, `http://${FIXTURE_HOST}:${address.port}`);

    const page = await fetch(`${running.origin}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/u);
    assert.match(await page.text(), /data-fixture-ready="false"/u);

    const script = await fetch(`${running.origin}/assets/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/u);

    const redirect = await fetch(`${running.origin}/redirect`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/?redirected=1#redirect-complete');

    const firstCache = await fetch(`${running.origin}/resource/cache`);
    assert.equal(firstCache.status, 200);
    assert.equal(firstCache.headers.get('cache-control'), 'public, max-age=60');
    const cached = await fetch(`${running.origin}/resource/cache`, {
      headers: { 'If-None-Match': firstCache.headers.get('etag') ?? '' },
    });
    assert.equal(cached.status, 304);

    const slow = await fetch(`${running.origin}/resource/slow?delay=1`);
    assert.deepEqual(await slow.json(), { fixture: 'slow', delay: 1 });

    const failure = await fetch(`${running.origin}/resource/fail`);
    assert.equal(failure.status, 503);
    assert.deepEqual(await failure.json(), { error: 'fixture-intentional-failure' });

    await assert.rejects(fetch(`${running.origin}/resource/abort`));

    const missing = await fetch(`${running.origin}/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: 'fixture-route-not-found',
      path: '/missing',
    });

    const method = await fetch(`${running.origin}/`, { method: 'POST' });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'GET, HEAD');
  } finally {
    await closeServer(running.server);
  }
});

test('fixture static assets retain the required real-browser reliability markers', async () => {
  const fixtureUrl = new URL('./', import.meta.url);
  const [html, script, styles, server] = await Promise.all([
    readFile(new URL('index.html', fixtureUrl), 'utf8'),
    readFile(new URL('assets/app.js', fixtureUrl), 'utf8'),
    readFile(new URL('assets/styles.css', fixtureUrl), 'utf8'),
    readFile(new URL('server.mjs', fixtureUrl), 'utf8'),
  ]);
  const source = `${html}\n${script}\n${styles}\n${server}`;
  const requiredMarkers = [
    'hidden-duplicate',
    'duplicate-label-a',
    'blocking-overlay',
    'offscreen-target',
    'disabled-control',
    'inert-region',
    'zero-size-target',
    'pointer-events-target',
    'custom-button',
    'hover-tooltip',
    '.hover-trigger:hover',
    'drag-source',
    'drop-target',
    'coordinate-canvas',
    'controlled-rerendering-input',
    'focus-replacement-input',
    'input-replacement-input',
    'keyboardShortcut',
    'alert-button',
    'confirm-button',
    'prompt-button',
    'consecutive-dialog-button',
    'beforeunload-toggle',
    'history.pushState',
    'history.replaceState',
    'popstate',
    'hashchange',
    '/redirect',
    '/resource/fetch',
    '/resource/xhr',
    '/resource/cache',
    '/resource/slow',
    '/resource/fail',
    '/resource/abort',
    '/resource/dynamic.js',
    '/resource/dynamic.svg',
    '/ws',
    'fixture-state',
    'fixture-log',
    'MAX_LOG_ENTRIES',
  ];

  for (const marker of requiredMarkers) {
    assert.match(source, new RegExp(marker.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});
