import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import type { ConsoleEntry, ConsoleStackFrame } from '../../../protocol/src/types.js';
import {
  createSourceResolver,
  findSourceMappingUrl,
  isLocalNetworkHost,
  readTabLoadedScripts,
  sourcePathFromFile,
  type LoadedScripts,
  type SourceResolverLimits,
} from '../src/background-source-maps.js';

const FIXTURES = new URL('../../../tests/fixtures/source-maps/generated/', import.meta.url);
const ORIGIN = 'https://app.test';
const ASSETS = `${ORIGIN}/assets`;

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES), 'utf8');
}

type Route = {
  body?: string | Uint8Array[];
  status?: number;
  headers?: Record<string, string>;
  /** Never respond; reject only when the request is aborted. */
  hang?: boolean;
  /** Simulate a server redirect, which fetch refuses with redirect: "error". */
  redirectTo?: string;
};

type FetchCall = { url: string; init: RequestInit };

/** A fake network: records every request and how many body bytes were read. */
function createNetwork(routes: Record<string, Route>) {
  const calls: FetchCall[] = [];
  const bytesRead = new Map<string, number>();
  async function fetch(url: string, init: RequestInit): Promise<Response> {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response('missing', { status: 404 });
    if (route.redirectTo) {
      // fetch with redirect: "error" rejects instead of requesting the target.
      assert.equal(init.redirect, 'error');
      throw new TypeError('Failed to fetch');
    }
    if (route.hang) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        );
      });
    }
    const chunks =
      typeof route.body === 'string' ? [new TextEncoder().encode(route.body)] : (route.body ?? []);
    let index = 0;
    // highWaterMark 0: a chunk is produced only when the reader asks for it.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (index >= chunks.length) {
            controller.close();
            return;
          }
          const chunk = chunks[index];
          index += 1;
          bytesRead.set(url, (bytesRead.get(url) ?? 0) + chunk.byteLength);
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 }
    );
    return new Response(stream, { status: route.status ?? 200, headers: route.headers ?? {} });
  }
  return {
    calls,
    bytesRead,
    fetch,
    urls: () => calls.map((call) => call.url),
  };
}

function frame(url: string, line: number, column: number, name?: string): ConsoleStackFrame {
  return name ? { function: name, url, line, column } : { url, line, column };
}

function entryWith(...stack: ConsoleStackFrame[]): ConsoleEntry {
  return { level: 'exception', args: ['Error: boom'], ts: 1, stack };
}

function loaded(...scripts: string[]): LoadedScripts {
  return { documentUrl: `${ORIGIN}/`, scripts };
}

function createResolver(
  network: ReturnType<typeof createNetwork>,
  loadedScripts: LoadedScripts | null | (() => Promise<LoadedScripts | null>),
  options: { limits?: Partial<SourceResolverLimits>; now?: () => number } = {}
) {
  let loadCount = 0;
  const resolver = createSourceResolver({
    fetch: network.fetch,
    readLoadedScripts: async () => {
      loadCount += 1;
      return typeof loadedScripts === 'function' ? loadedScripts() : loadedScripts;
    },
    limits: options.limits,
    now: options.now,
  });
  return { resolver, loadCount: () => loadCount };
}

function firstFrame(entries: ConsoleEntry[]): ConsoleStackFrame {
  const resolved = entries[0].stack?.[0];
  assert.ok(resolved);
  return resolved;
}

/** Generated 1-based column of the first `needle` on a fixture line. */
function columnOf(code: string, needle: string, line: number = 1): number {
  const text = code.split('\n')[line - 1];
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `${needle} not found`);
  return index + 1;
}

async function externalRoutes(): Promise<Record<string, Route>> {
  return {
    [`${ASSETS}/external.js`]: {
      body: await fixture('external.js'),
      headers: { etag: '"v1"' },
    },
    [`${ASSETS}/external.js.map`]: { body: await fixture('external.js.map') },
  };
}

test('resolves an external map to the original file, line, and column', async () => {
  const network = createNetwork(await externalRoutes());
  const code = await fixture('external.js');
  const { resolver } = createResolver(network, loaded(`${ASSETS}/external.js`));
  const entries = await resolver.resolve(7, [
    entryWith(frame(`${ASSETS}/external.js`, 1, columnOf(code, 'throw'), 'n')),
  ]);
  assert.deepEqual(firstFrame(entries), {
    function: 'n',
    url: `${ASSETS}/external.js`,
    line: 1,
    column: columnOf(code, 'throw'),
    source: { file: `${ORIGIN}/src/alpha.ts`, path: 'src/alpha.ts', line: 6, column: 5 },
  });
  assert.deepEqual(network.urls(), [`${ASSETS}/external.js`, `${ASSETS}/external.js.map`]);
  for (const call of network.calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'include', 'same-origin script sends credentials');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test('resolves an inline data: map without a map request', async () => {
  const code = await fixture('inline.js');
  const network = createNetwork({ [`${ASSETS}/inline.js`]: { body: code } });
  const { resolver } = createResolver(network, loaded(`${ASSETS}/inline.js`));
  const entries = await resolver.resolve(7, [
    entryWith(frame(`${ASSETS}/inline.js`, 1, columnOf(code, 'throw'))),
  ]);
  assert.deepEqual(firstFrame(entries).source, {
    file: `${ORIGIN}/src/alpha.ts`,
    path: 'src/alpha.ts',
    line: 6,
    column: 5,
  });
  assert.deepEqual(network.urls(), [`${ASSETS}/inline.js`]);
});

test('resolves frames in both sections of an index map', async () => {
  const code = await fixture('index.js');
  const network = createNetwork({
    [`${ASSETS}/index.js`]: { body: code },
    [`${ASSETS}/index.js.map`]: { body: await fixture('index.js.map') },
  });
  const { resolver } = createResolver(network, loaded(`${ASSETS}/index.js`));
  const entries = await resolver.resolve(7, [
    entryWith(
      frame(`${ASSETS}/index.js`, 1, columnOf(code, 'throw', 1)),
      frame(`${ASSETS}/index.js`, 3, columnOf(code, 'throw', 3)),
      frame(`${ASSETS}/index.js`, 3, columnOf(code, 'parseInt', 3))
    ),
  ]);
  assert.deepEqual(
    entries[0].stack?.map((resolved) => resolved.source),
    [
      { file: `${ORIGIN}/src/alpha.ts`, path: 'src/alpha.ts', line: 6, column: 5 },
      { file: `${ORIGIN}/src/beta.ts`, path: 'src/beta.ts', line: 5, column: 5 },
      { file: `${ORIGIN}/src/beta.ts`, path: 'src/beta.ts', line: 3, column: 24 },
    ]
  );
  assert.equal(network.calls.length, 2, 'one script and one map for three frames');
});

test('sourcesContent from any fixture never appears in a result', async () => {
  const external = await fixture('external.js');
  const index = await fixture('index.js');
  const inline = await fixture('inline.js');
  for (const name of ['external.js.map', 'index.js.map']) {
    assert.ok((await fixture(name)).includes('SOURCES_CONTENT_CANARY'), 'fixture holds a canary');
  }
  const network = createNetwork({
    ...(await externalRoutes()),
    [`${ASSETS}/inline.js`]: { body: inline },
    [`${ASSETS}/index.js`]: { body: index },
    [`${ASSETS}/index.js.map`]: { body: await fixture('index.js.map') },
  });
  const { resolver } = createResolver(
    network,
    loaded(`${ASSETS}/external.js`, `${ASSETS}/inline.js`, `${ASSETS}/index.js`)
  );
  const entries = await resolver.resolve(7, [
    entryWith(
      frame(`${ASSETS}/external.js`, 1, columnOf(external, 'throw')),
      frame(`${ASSETS}/inline.js`, 1, columnOf(inline, 'throw')),
      frame(`${ASSETS}/index.js`, 3, columnOf(index, 'throw', 3))
    ),
  ]);
  const text = JSON.stringify(entries);
  assert.equal(
    entries[0].stack?.every((resolved) => resolved.source),
    true
  );
  assert.equal(text.includes('SOURCES_CONTENT_CANARY'), false);
  assert.equal(text.includes('sourcesContent'), false);
  assert.equal(text.includes('negative total for'), false);
});

test('a second read of the same script performs no second fetch', async () => {
  const network = createNetwork(await externalRoutes());
  const code = await fixture('external.js');
  const { resolver } = createResolver(network, loaded(`${ASSETS}/external.js`));
  const entries = [entryWith(frame(`${ASSETS}/external.js`, 1, columnOf(code, 'throw')))];
  const first = await resolver.resolve(7, entries);
  assert.equal(network.calls.length, 2);
  const second = await resolver.resolve(7, entries);
  assert.equal(network.calls.length, 2, 'cached map reused without a request');
  assert.deepEqual(second, first);
  assert.equal(resolver.cacheSize, 1);
});

test('a stale entry revalidates the script and skips the map when the validator matches', async () => {
  let clock = 1_000;
  const network = createNetwork(await externalRoutes());
  const code = await fixture('external.js');
  const { resolver } = createResolver(network, loaded(`${ASSETS}/external.js`), {
    now: () => clock,
    limits: { freshMs: 100 },
  });
  const entries = [entryWith(frame(`${ASSETS}/external.js`, 1, columnOf(code, 'throw')))];
  await resolver.resolve(7, entries);
  clock += 500;
  const again = await resolver.resolve(7, entries);
  assert.deepEqual(network.urls(), [
    `${ASSETS}/external.js`,
    `${ASSETS}/external.js.map`,
    `${ASSETS}/external.js`,
  ]);
  assert.equal(firstFrame(again).source?.line, 6);
});

test('clear drops cached maps so the next read fetches again', async () => {
  const network = createNetwork(await externalRoutes());
  const code = await fixture('external.js');
  const { resolver } = createResolver(network, loaded(`${ASSETS}/external.js`));
  const entries = [entryWith(frame(`${ASSETS}/external.js`, 1, columnOf(code, 'throw')))];
  await resolver.resolve(7, entries);
  resolver.clear();
  assert.equal(resolver.cacheSize, 0);
  await resolver.resolve(7, entries);
  assert.equal(network.calls.length, 4);
});

test('a same-length rebuild without a validator reads the new map', async () => {
  const script = `${ASSETS}/app.js`;
  const routes: Record<string, Route> = {
    [script]: { body: '//# sourceMappingURL=a.map', headers: { 'content-length': '26' } },
  };
  for (const name of ['a', 'b'])
    routes[`${ASSETS}/${name}.map`] = {
      body: JSON.stringify({ version: 3, names: [], sources: [`${name}.ts`], mappings: 'AAAA' }),
    };
  const network = createNetwork(routes);
  const { resolver } = createResolver(network, loaded(script), {
    limits: { freshMs: 0 },
  });
  const read = async () =>
    firstFrame(await resolver.resolve(7, [entryWith(frame(script, 1, 1))])).source?.path;
  assert.equal(await read(), 'assets/a.ts');
  routes[script].body = '//# sourceMappingURL=b.map';
  assert.equal(await read(), 'assets/b.ts');
  assert.deepEqual(network.urls(), [script, `${ASSETS}/a.map`, script, `${ASSETS}/b.map`]);
});

test('refuses a frame URL the tab did not load without any request', async () => {
  const network = createNetwork(await externalRoutes());
  const { resolver } = createResolver(network, loaded(`${ASSETS}/external.js`));
  const entries = await resolver.resolve(7, [
    entryWith(
      frame('http://192.168.1.1/admin.js', 1, 1),
      frame(`${ASSETS}/external.js.map`, 1, 1),
      frame(`${ORIGIN}/assets/other.js`, 1, 1)
    ),
  ]);
  assert.deepEqual(
    entries[0].stack?.map((resolved) => resolved.sourceUnavailable),
    ['not_a_loaded_script', 'not_a_loaded_script', 'not_a_loaded_script']
  );
  assert.equal(network.calls.length, 0);
});

test('a public page cannot point resolution at the local network', async () => {
  // Even a browser-observed script load does not waive the network check.
  const targets = [
    'http://192.168.1.1/admin.js',
    'http://127.0.0.1:8080/app.js',
    'http://localhost:3000/app.js',
    'http://[::1]/app.js',
    'http://[::ffff:10.0.0.5]/app.js',
    'http://[fd00::1]/app.js',
    'http://printer/status.js',
    'https://nas.local/app.js',
    'http://169.254.169.254/latest/meta-data.js',
  ];
  const network = createNetwork({});
  const { resolver } = createResolver(network, loaded(...targets));
  const entries = await resolver.resolve(7, [
    entryWith(...targets.map((url) => frame(new URL(url).href, 1, 1))),
  ]);
  assert.deepEqual(
    entries[0].stack?.map((resolved) => resolved.sourceUnavailable),
    targets.map(() => 'local_network_script')
  );
  assert.equal(network.calls.length, 0);
});

test('a local page may resolve its own and other local scripts', async () => {
  const code = await fixture('external.js');
  const map = await fixture('external.js.map');
  const network = createNetwork({
    'http://localhost:3000/app.js': { body: code },
    'http://localhost:3000/external.js.map': { body: map },
    'http://localhost:5173/app.js': { body: code },
    'http://localhost:5173/external.js.map': { body: map },
  });
  const { resolver } = createResolver(network, {
    documentUrl: 'http://localhost:3000/',
    scripts: ['http://localhost:3000/app.js', 'http://localhost:5173/app.js'],
  });
  const column = columnOf(code, 'throw');
  const entries = await resolver.resolve(7, [
    entryWith(
      frame('http://localhost:3000/app.js', 1, column),
      frame('http://localhost:5173/app.js', 1, column)
    ),
  ]);
  assert.deepEqual(
    entries[0].stack?.map((resolved) => resolved.sourceUnavailable),
    [undefined, undefined]
  );
  assert.ok(entries[0].stack?.every((resolved) => resolved.source));
  const credentials = new Map(network.calls.map((call) => [call.url, call.init.credentials]));
  assert.equal(credentials.get('http://localhost:3000/app.js'), 'include');
  assert.equal(credentials.get('http://localhost:5173/app.js'), 'omit');
});

test('a local-network script is refused when the document URL is unknown or not http', async () => {
  for (const documentUrl of ['', 'about:blank', 'file:///Users/me/index.html']) {
    const network = createNetwork({});
    const { resolver } = createResolver(network, {
      documentUrl,
      scripts: ['http://localhost:3000/app.js'],
    });
    const entries = await resolver.resolve(7, [
      entryWith(frame('http://localhost:3000/app.js', 1, 1)),
    ]);
    assert.equal(firstFrame(entries).sourceUnavailable, 'local_network_script');
    assert.equal(network.calls.length, 0);
  }
});

test('isLocalNetworkHost classifies URL hostnames', () => {
  const host = (url: string): string => new URL(url).hostname;
  for (const local of [
    'http://localhost/',
    'http://api.localhost/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0.0.0.0/',
    'http://10.1.2.3/',
    'http://100.64.0.1/',
    'http://169.254.1.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.0.10/',
    'http://[::]/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[::ffff:192.168.1.1]/',
    'http://router/',
    'http://nas.local./',
    'http://build.internal/',
    'http://wiki.corp/',
    'http://pi.home.arpa/',
  ]) {
    assert.equal(isLocalNetworkHost(host(local)), true, local);
  }
  for (const remote of [
    'https://example.com/',
    'https://cdn.example.co.uk/',
    'http://8.8.8.8/',
    'http://172.32.0.1/',
    'http://100.128.0.1/',
    'http://192.169.0.1/',
    'http://[2001:4860:4860::8888]/',
    'http://[::ffff:8.8.8.8]/',
    'https://localhost.example.com/',
    'https://my-local.example/',
  ]) {
    assert.equal(isLocalNetworkHost(host(remote)), false, remote);
  }
  assert.equal(isLocalNetworkHost(''), true);
  assert.equal(isLocalNetworkHost('[not-an-address]'), true);
});

test('refuses non-http frame URLs without reading the loaded list or any request', async () => {
  const network = createNetwork({});
  const { resolver } = createResolver(
    network,
    loaded('blob:https://app.test/1', 'file:///Users/me/app.js', 'chrome-extension://abc/a.js')
  );
  const entries = await resolver.resolve(7, [
    entryWith(
      frame('blob:https://app.test/1', 1, 1),
      frame('file:///Users/me/app.js', 1, 1),
      frame('chrome-extension://abc/a.js', 1, 1),
      frame('data:text/javascript,1', 1, 1)
    ),
  ]);
  assert.deepEqual(
    entries[0].stack?.map((resolved) => resolved.sourceUnavailable),
    ['unsupported_scheme', 'unsupported_scheme', 'unsupported_scheme', 'unsupported_scheme']
  );
  assert.equal(network.calls.length, 0);
});

test('fails closed without any request when the loaded-script list is unavailable', async () => {
  for (const unavailable of [
    null,
    async () => {
      throw new Error('Cannot access contents of the page');
    },
    async () => ({ documentUrl: `${ORIGIN}/`, scripts: [42] }) as unknown as LoadedScripts,
  ]) {
    const network = createNetwork(await externalRoutes());
    const { resolver } = createResolver(network, unavailable);
    const entries = await resolver.resolve(7, [entryWith(frame(`${ASSETS}/external.js`, 1, 1))]);
    assert.equal(firstFrame(entries).sourceUnavailable, 'loaded_scripts_unavailable');
    assert.equal(network.calls.length, 0);
  }
});

test('refuses a frame that matches two loaded scripts after URL sanitization', async () => {
  const network = createNetwork({});
  const { resolver } = createResolver(
    network,
    loaded(`${ASSETS}/app.js?v=1`, `${ASSETS}/app.js?v=2`)
  );
  const entries = await resolver.resolve(7, [
    entryWith(frame(`${ASSETS}/app.js?v=%5Bredacted%5D`, 1, 1)),
  ]);
  assert.equal(firstFrame(entries).sourceUnavailable, 'ambiguous_script');
  assert.equal(network.calls.length, 0);
});

test('matches a sanitized frame URL to the raw loaded URL and fetches only that URL', async () => {
  const routes = await externalRoutes();
  const network = createNetwork({
    [`${ASSETS}/external.js?v=42`]: routes[`${ASSETS}/external.js`],
    [`${ASSETS}/external.js.map`]: routes[`${ASSETS}/external.js.map`],
  });
  const code = await fixture('external.js');
  const { resolver } = createResolver(network, loaded(`${ASSETS}/external.js?v=42`));
  const entries = await resolver.resolve(7, [
    entryWith(frame(`${ASSETS}/external.js?v=%5Bredacted%5D`, 1, columnOf(code, 'throw'))),
  ]);
  assert.equal(firstFrame(entries).source?.path, 'src/alpha.ts');
  assert.deepEqual(network.urls(), [`${ASSETS}/external.js?v=42`, `${ASSETS}/external.js.map`]);
});

test('refuses a cross-origin map URL without requesting it', async () => {
  const network = createNetwork({
    [`${ASSETS}/app.js`]: {
      body: 'throw 1;\n//# sourceMappingURL=https://evil.test/app.js.map\n',
    },
    'https://evil.test/app.js.map': { body: await fixture('external.js.map') },
  });
  const { resolver } = createResolver(network, loaded(`${ASSETS}/app.js`));
  const entries = await resolver.resolve(7, [entryWith(frame(`${ASSETS}/app.js`, 1, 1))]);
  assert.equal(firstFrame(entries).sourceUnavailable, 'cross_origin_map');
  assert.deepEqual(network.urls(), [`${ASSETS}/app.js`]);
});

test('refuses a cross-origin SourceMap header and non-http map URLs without requesting them', async () => {
  const cases: Array<[Route, string]> = [
    [{ body: 'throw 1;', headers: { sourcemap: 'http://192.168.1.1/x.map' } }, 'cross_origin_map'],
    [{ body: 'throw 1;\n//# sourceMappingURL=file:///etc/passwd\n' }, 'unsupported_map_url'],
    [
      { body: 'throw 1;\n//# sourceMappingURL=chrome-extension://abc/x.map\n' },
      'unsupported_map_url',
    ],
    [{ body: 'throw 1;\n//# sourceMappingURL=blob:https://app.test/1\n' }, 'unsupported_map_url'],
    [{ body: 'throw 1;\n//# sourceMappingURL=http://[::1\n' }, 'invalid_map_url'],
  ];
  for (const [route, reason] of cases) {
    const network = createNetwork({ [`${ASSETS}/app.js`]: route });
    const { resolver } = createResolver(network, loaded(`${ASSETS}/app.js`));
    const entries = await resolver.resolve(7, [entryWith(frame(`${ASSETS}/app.js`, 1, 1))]);
    assert.equal(firstFrame(entries).sourceUnavailable, reason);
    assert.deepEqual(network.urls(), [`${ASSETS}/app.js`], reason);
  }
});

test('prefers the SourceMap header over the comment', async () => {
  const code = await fixture('external.js');
  const network = createNetwork({
    [`${ASSETS}/external.js`]: {
      body: code.replace('external.js.map', 'missing.js.map'),
      headers: { sourcemap: '/maps/alpha.map' },
    },
    [`${ORIGIN}/maps/alpha.map`]: { body: await fixture('external.js.map') },
  });
  const { resolver } = createResolver(network, loaded(`${ASSETS}/external.js`));
  const entries = await resolver.resolve(7, [
    entryWith(frame(`${ASSETS}/external.js`, 1, columnOf(code, 'throw'))),
  ]);
  // Relative sources resolve against the map URL, not the script.
  assert.deepEqual(firstFrame(entries).source, {
    file: `${ORIGIN}/src/alpha.ts`,
    path: 'src/alpha.ts',
    line: 6,
    column: 5,
  });
  assert.deepEqual(network.urls(), [`${ASSETS}/external.js`, `${ORIGIN}/maps/alpha.map`]);
});

test('omits credentials for a script on another origin than the document', async () => {
  const cdn = 'https://cdn.test/lib';
  const routes = await externalRoutes();
  const network = createNetwork({
    [`${cdn}/external.js`]: routes[`${ASSETS}/external.js`],
    [`${cdn}/external.js.map`]: routes[`${ASSETS}/external.js.map`],
  });
  const code = await fixture('external.js');
  const { resolver } = createResolver(network, loaded(`${cdn}/external.js`));
  const entries = await resolver.resolve(7, [
    entryWith(frame(`${cdn}/external.js`, 1, columnOf(code, 'throw'))),
  ]);
  assert.equal(firstFrame(entries).source?.file, 'https://cdn.test/src/alpha.ts');
  assert.deepEqual(
    network.calls.map((call) => call.init.credentials),
    ['omit', 'omit']
  );
});

test('refuses a script whose declared length exceeds the cap without reading its body', async () => {
  const network = createNetwork({
    [`${ASSETS}/big.js`]: {
      body: [new Uint8Array(64)],
      headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
    },
  });
  const { resolver } = createResolver(network, loaded(`${ASSETS}/big.js`));
  const entries = await resolver.resolve(7, [entryWith(frame(`${ASSETS}/big.js`, 1, 1))]);
  assert.equal(firstFrame(entries).sourceUnavailable, 'script_too_large');
  assert.equal(network.bytesRead.get(`${ASSETS}/big.js`) ?? 0, 0);
  assert.equal(network.calls.length, 1);
});

test('stops reading a script body as soon as it exceeds the cap', async () => {
  const chunk = new Uint8Array(1024).fill(0x20);
  const network = createNetwork({
    [`${ASSETS}/stream.js`]: { body: Array.from({ length: 100 }, () => chunk) },
  });
  const { resolver } = createResolver(network, loaded(`${ASSETS}/stream.js`), {
    limits: { maxScriptBytes: 4 * 1024 },
  });
  const entries = await resolver.resolve(7, [entryWith(frame(`${ASSETS}/stream.js`, 1, 1))]);
  assert.equal(firstFrame(entries).sourceUnavailable, 'script_too_large');
  const read = network.bytesRead.get(`${ASSETS}/stream.js`) ?? 0;
  assert.ok(read <= 6 * 1024, `read ${read} bytes of a 100 KiB body`);
  assert.equal(network.calls.length, 1, 'no map request after refusal');
});

test('refuses an oversize map, declared or streamed', async () => {
  const code = 'throw 1;\n//# sourceMappingURL=app.js.map\n';
  for (const route of [
    { body: '{}', headers: { 'content-length': String(20 * 1024 * 1024 + 1) } },
    { body: Array.from({ length: 64 }, () => new Uint8Array(1024).fill(0x20)) },
  ] satisfies Route[]) {
    const network = createNetwork({
      [`${ASSETS}/app.js`]: { body: code },
      [`${ASSETS}/app.js.map`]: route,
    });
    const { resolver } = createResolver(network, loaded(`${ASSETS}/app.js`), {
      limits: { maxMapBytes: route.headers ? 20 * 1024 * 1024 : 8 * 1024 },
    });
    const entries = await resolver.resolve(7, [entryWith(frame(`${ASSETS}/app.js`, 1, 1))]);
    assert.equal(firstFrame(entries).sourceUnavailable, 'map_too_large');
  }
  // An inline map is checked before it is decoded.
  const inlineNetwork = createNetwork({
    [`${ASSETS}/inline.js`]: {
      body: `throw 1;\n//# sourceMappingURL=data:application/json;base64,${'A'.repeat(16_000)}\n`,
    },
  });
  const { resolver } = createResolver(inlineNetwork, loaded(`${ASSETS}/inline.js`), {
    limits: { maxMapBytes: 8 * 1024 },
  });
  const entries = await resolver.resolve(7, [entryWith(frame(`${ASSETS}/inline.js`, 1, 1))]);
  assert.equal(firstFrame(entries).sourceUnavailable, 'map_too_large');
  assert.equal(inlineNetwork.calls.length, 1);
});

test('times out a hanging request and still returns every frame', async () => {
  const network = createNetwork({ [`${ASSETS}/slow.js`]: { hang: true } });
  const { resolver } = createResolver(network, loaded(`${ASSETS}/slow.js`), {
    limits: { fetchTimeoutMs: 20 },
  });
  const started = Date.now();
  const entries = await resolver.resolve(7, [entryWith(frame(`${ASSETS}/slow.js`, 1, 9))]);
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(firstFrame(entries), {
    url: `${ASSETS}/slow.js`,
    line: 1,
    column: 9,
    sourceUnavailable: 'fetch_timeout',
  });
});

test('times out a hanging map request', async () => {
  const network = createNetwork({
    [`${ASSETS}/app.js`]: { body: 'throw 1;\n//# sourceMappingURL=app.js.map\n' },
    [`${ASSETS}/app.js.map`]: { hang: true },
  });
  const { resolver } = createResolver(network, loaded(`${ASSETS}/app.js`), {
    limits: { fetchTimeoutMs: 20 },
  });
  const entries = await resolver.resolve(7, [entryWith(frame(`${ASSETS}/app.js`, 1, 1))]);
  assert.equal(firstFrame(entries).sourceUnavailable, 'fetch_timeout');
});

test('reports malformed maps without failing the read', async () => {
  const bodies = [
    'not json',
    '{"version":2,"sources":[],"mappings":""}',
    '{"version":3,"sources":["a.ts"]}',
    '{"version":3,"sources":["a.ts"],"mappings":"!!!!"}',
    '{"version":3,"sections":{},"sources":[],"mappings":""}',
    '{"version":3,"sections":[{"offset":{"line":0,"column":0},"url":"https://app.test/x.map"}]}',
    '[]',
  ];
  for (const body of bodies) {
    const network = createNetwork({
      [`${ASSETS}/app.js`]: { body: 'throw 1;\n//# sourceMappingURL=app.js.map\n' },
      [`${ASSETS}/app.js.map`]: { body },
    });
    const { resolver } = createResolver(network, loaded(`${ASSETS}/app.js`));
    const entries = await resolver.resolve(7, [entryWith(frame(`${ASSETS}/app.js`, 1, 1))]);
    assert.equal(firstFrame(entries).sourceUnavailable, 'malformed_map', body);
    assert.equal(network.calls.length, 2, 'a sections url is never fetched');
  }
  // A segment that names a source the map lacks is unmapped, not a crash.
  const dangling = createNetwork({
    [`${ASSETS}/app.js`]: { body: 'throw 1;\n//# sourceMappingURL=app.js.map\n' },
    [`${ASSETS}/app.js.map`]: { body: '{"version":3,"sources":[],"mappings":"AAAA"}' },
  });
  const { resolver: danglingResolver } = createResolver(dangling, loaded(`${ASSETS}/app.js`));
  const unmapped = await danglingResolver.resolve(7, [entryWith(frame(`${ASSETS}/app.js`, 1, 1))]);
  assert.equal(firstFrame(unmapped).sourceUnavailable, 'no_mapping');
  const inline = createNetwork({
    [`${ASSETS}/inline.js`]: {
      body: 'throw 1;\n//# sourceMappingURL=data:application/json;base64,%%%\n',
    },
  });
  const { resolver } = createResolver(inline, loaded(`${ASSETS}/inline.js`));
  const entries = await resolver.resolve(7, [entryWith(frame(`${ASSETS}/inline.js`, 1, 1))]);
  assert.equal(firstFrame(entries).sourceUnavailable, 'malformed_map');
});

test('index maps bound cumulative offsets and decoded line counts before flattening', async () => {
  const script = `${ASSETS}/index.js`;
  const leaf = { version: 3, mappings: 'AAAA', names: [], sources: ['index.ts'] };
  const section = (line: number, map: unknown) => ({
    version: 3,
    sections: [{ offset: { line, column: 0 }, map }],
  });
  for (const [map, reason] of [
    [section(60_000, section(41_000, leaf)), 'map_too_large'],
    [section(99_999, { ...leaf, mappings: 'AAAA;AAAA' }), 'map_too_large'],
    [section(-1, leaf), 'malformed_map'],
  ] as const) {
    const network = createNetwork({
      [script]: { body: '//# sourceMappingURL=index.map' },
      [`${ASSETS}/index.map`]: { body: JSON.stringify(map) },
    });
    const { resolver } = createResolver(network, loaded(script));
    assert.equal(
      firstFrame(await resolver.resolve(7, [entryWith(frame(script, 1, 1))])).sourceUnavailable,
      reason
    );
  }
});

test('reports a script without a map, failed requests, and unmapped positions', async () => {
  const code = await fixture('external.js');
  const network = createNetwork({
    [`${ASSETS}/plain.js`]: { body: 'throw new Error("x");\n' },
    [`${ASSETS}/gone.js`]: { status: 404, body: 'missing' },
    [`${ASSETS}/moved.js`]: { redirectTo: 'http://192.168.1.1/admin.js' },
    [`${ASSETS}/lost-map.js`]: { body: 'throw 1;\n//# sourceMappingURL=lost.map\n' },
    ...(await externalRoutes()),
  });
  const { resolver } = createResolver(
    network,
    loaded(
      `${ASSETS}/plain.js`,
      `${ASSETS}/gone.js`,
      `${ASSETS}/moved.js`,
      `${ASSETS}/lost-map.js`,
      `${ASSETS}/external.js`
    )
  );
  const entries = await resolver.resolve(7, [
    entryWith(
      frame(`${ASSETS}/plain.js`, 1, 1),
      frame(`${ASSETS}/gone.js`, 1, 1),
      frame(`${ASSETS}/moved.js`, 1, 1),
      frame(`${ASSETS}/lost-map.js`, 1, 1),
      frame(`${ASSETS}/external.js`, 99, 1),
      frame(`${ASSETS}/external.js`, 1, columnOf(code, 'throw'))
    ),
  ]);
  assert.deepEqual(
    entries[0].stack?.map((resolved) => resolved.sourceUnavailable ?? resolved.source?.path),
    [
      'no_source_map',
      'script_fetch_failed',
      'script_fetch_failed',
      'map_fetch_failed',
      'no_mapping',
      'src/alpha.ts',
    ]
  );
  assert.equal(network.urls().includes('http://192.168.1.1/admin.js'), false);
});

test('bounds the number of scripts and the time spent per read', async () => {
  const network = createNetwork({
    [`${ASSETS}/a.js`]: { body: 'throw 1;' },
    [`${ASSETS}/b.js`]: { body: 'throw 2;' },
  });
  const { resolver } = createResolver(network, loaded(`${ASSETS}/a.js`, `${ASSETS}/b.js`), {
    limits: { maxScripts: 1 },
  });
  const entries = await resolver.resolve(7, [
    entryWith(frame(`${ASSETS}/a.js`, 1, 1), frame(`${ASSETS}/b.js`, 1, 1)),
    entryWith(frame(`${ASSETS}/a.js`, 2, 1)),
  ]);
  assert.equal(entries[0].stack?.[0].sourceUnavailable, 'no_source_map');
  assert.equal(entries[0].stack?.[1].sourceUnavailable, 'budget_exhausted');
  assert.equal(entries[1].stack?.[0].sourceUnavailable, 'no_source_map');
  assert.deepEqual(network.urls(), [`${ASSETS}/a.js`]);

  let clock = 0;
  const late = createNetwork({ [`${ASSETS}/a.js`]: { body: 'throw 1;' } });
  const { resolver: slow } = createResolver(
    late,
    async () => {
      clock += 10_000; // Reading the list alone spends the whole budget.
      return loaded(`${ASSETS}/a.js`);
    },
    { now: () => clock }
  );
  const timed = await slow.resolve(7, [entryWith(frame(`${ASSETS}/a.js`, 1, 1))]);
  assert.equal(firstFrame(timed).sourceUnavailable, 'budget_exhausted');
  assert.equal(late.calls.length, 0);
});

test('skips all work when no entry has a stack', async () => {
  const network = createNetwork({});
  const { resolver, loadCount } = createResolver(network, loaded());
  const entries: ConsoleEntry[] = [{ level: 'log', args: ['hi'], ts: 1 }];
  assert.strictEqual(await resolver.resolve(7, entries), entries);
  assert.equal(loadCount(), 0);
});

test('keeps bundler source URLs as written and bounds untrusted map text', async () => {
  const code = await fixture('external.js');
  const map = JSON.parse(await fixture('external.js.map')) as {
    sources: string[];
    names: string[];
  };
  const bidi = String.fromCodePoint(0x202e);
  const bell = String.fromCodePoint(0x07);
  map.sources = [`webpack://shop/./src/alpha.ts`];
  const webpackNetwork = createNetwork({
    [`${ASSETS}/external.js`]: { body: code },
    [`${ASSETS}/external.js.map`]: { body: JSON.stringify(map) },
  });
  const { resolver } = createResolver(webpackNetwork, loaded(`${ASSETS}/external.js`));
  const entries = await resolver.resolve(7, [
    entryWith(frame(`${ASSETS}/external.js`, 1, columnOf(code, 'throw'))),
  ]);
  assert.deepEqual(firstFrame(entries).source, {
    file: 'webpack://shop/./src/alpha.ts',
    path: 'src/alpha.ts',
    line: 6,
    column: 5,
  });

  map.sources = [`webpack:///src/${bidi}evil${bell}${'x'.repeat(2_000)}.ts`];
  map.names = map.names.map(() => `name${bidi}${bell}${'n'.repeat(1_000)}`);
  const hostile = createNetwork({
    [`${ASSETS}/external.js`]: { body: code },
    [`${ASSETS}/external.js.map`]: { body: JSON.stringify(map) },
  });
  const { resolver: hostileResolver } = createResolver(hostile, loaded(`${ASSETS}/external.js`));
  const named = await hostileResolver.resolve(7, [
    entryWith(frame(`${ASSETS}/external.js`, 1, columnOf(code, 'n(r)') + 9)),
  ]);
  const source = firstFrame(named).source;
  assert.ok(source);
  for (const text of [source.file, source.path, source.name ?? '']) {
    assert.equal(text.includes(bidi), false);
    assert.equal(text.includes(bell), false);
  }
  assert.ok(source.file.length <= 512);
  assert.ok(source.path.length <= 512);
  assert.ok(source.file.startsWith('webpack:///src/evil'));
  if (source.name !== undefined) assert.ok(source.name.length <= 200);
});

test('findSourceMappingUrl reads the last real comment', () => {
  assert.equal(findSourceMappingUrl('a()\n//# sourceMappingURL=a.js.map\n'), 'a.js.map');
  assert.equal(findSourceMappingUrl('a()\n//@ sourceMappingURL=old.map'), 'old.map');
  assert.equal(findSourceMappingUrl('a()\n/*# sourceMappingURL=c.map */'), 'c.map');
  assert.equal(
    findSourceMappingUrl('//# sourceMappingURL=first.map\nb()\n//# sourceMappingURL=last.map'),
    'last.map'
  );
  assert.equal(
    findSourceMappingUrl('//# sourceMappingURL=real.map\nconst s = "sourceMappingURL=fake.map";'),
    'real.map'
  );
  assert.equal(findSourceMappingUrl('const s = "sourceMappingURL=fake.map";'), null);
  assert.equal(findSourceMappingUrl('nothing here'), null);
  assert.equal(findSourceMappingUrl('//# sourceMappingURL= \n'), null);
});

test('sourcePathFromFile strips schemes, bundler namespaces, and leading ./', () => {
  const cases: Array<[string, string]> = [
    ['webpack://shop/./src/a.ts', 'src/a.ts'],
    ['webpack:///./src/a.ts', 'src/a.ts'],
    ['webpack:///src/a.ts', 'src/a.ts'],
    ['webpack://shop/node_modules/x/index.js', 'shop/node_modules/x/index.js'],
    ['https://app.test/src/a.ts?raw', 'src/a.ts'],
    ['file:///Users/me/app/src/a.ts', '/Users/me/app/src/a.ts'],
    ['./src/a.ts', 'src/a.ts'],
    ['src/./lib/a.ts', 'src/lib/a.ts'],
    ['vite:/@fs/x.ts', '@fs/x.ts'],
  ];
  for (const [file, expected] of cases) assert.equal(sourcePathFromFile(file), expected, file);
});

test('only successful browser-observed script loads authorize a fetch, never DOM-only src values', async (t) => {
  const page = globalThis as Record<string, unknown>;
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else delete page.document;
  });
  const script = (src: string, type: string | null = null, noModule = false) => ({
    src,
    noModule,
    getAttribute: (name: string) => (name === 'type' ? type : null),
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      URL: `${ORIGIN}/page`,
      scripts: [
        script(`${ASSETS}/app.js`),
        script(`${ASSETS}/mod.js`, 'module'),
        script(`${ASSETS}/classic.js`, 'text/javascript'),
        script('http://192.168.1.1/admin.js', 'text/plain'),
        script(`${ASSETS}/legacy.js`, null, true),
        script(''),
      ],
    },
  });
  t.mock.method(performance, 'getEntriesByType', (type: string) =>
    type === 'resource'
      ? [
          { name: `${ASSETS}/chunk.js`, initiatorType: 'script', responseStatus: 200 },
          { name: `${ASSETS}/blocked.js`, initiatorType: 'script', responseStatus: 0 },
          { name: `${ASSETS}/style.css`, initiatorType: 'link', responseStatus: 200 },
          { name: `${ORIGIN}/api/data`, initiatorType: 'fetch', responseStatus: 200 },
        ]
      : []
  );
  const calls: Array<{ target: unknown; world: unknown }> = [];
  const chromeObj = {
    scripting: {
      async executeScript<Args extends unknown[], Result>(
        config: chrome.scripting.ScriptInjection<Args, Result>
      ) {
        calls.push({ target: config.target, world: config.world });
        return [{ result: config.func?.(...([] as unknown as Args)) }];
      },
    },
  };
  assert.deepEqual(await readTabLoadedScripts(9, chromeObj), {
    documentUrl: `${ORIGIN}/page`,
    scripts: [`${ASSETS}/chunk.js`],
  });
  assert.deepEqual(calls, [{ target: { tabId: 9, frameIds: [0] }, world: 'ISOLATED' }]);

  const failing = {
    scripting: {
      async executeScript(): Promise<unknown[]> {
        throw new Error('Cannot access contents of the page');
      },
    },
  };
  assert.equal(await readTabLoadedScripts(9, failing), null);
  const malformed = {
    scripting: {
      async executeScript(): Promise<unknown[]> {
        return [{ result: { documentUrl: 5, scripts: 'x' } }];
      },
    },
  };
  assert.equal(await readTabLoadedScripts(9, malformed), null);
});
