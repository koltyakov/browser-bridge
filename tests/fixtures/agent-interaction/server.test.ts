import assert from 'node:assert/strict';
import test from 'node:test';

import { INTERACTION_FIXTURE_HOST, startInteractionFixtureServer } from './server.mjs';

test('interaction fixture serves the page, SPA route, and payment frame on loopback', async () => {
  const { server, origin } = await startInteractionFixtureServer({ port: 0 });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, INTERACTION_FIXTURE_HOST);

    for (const route of ['/', '/dashboard']) {
      const page = await fetch(`${origin}${route}`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /<label for="email">Email address<\/label>/u);
      assert.match(html, /attachShadow\(\{ mode: 'closed' \}\)/u);
      assert.match(html, /setTimeout\(\(\) => animated\.classList\.add\('in'\), 100\)/u);
    }
    const frame = await fetch(`${origin}/frame.html`);
    assert.match(await frame.text(), /Pay now/u);
    assert.equal((await fetch(`${origin}/missing`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
