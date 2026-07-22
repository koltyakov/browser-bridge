// @ts-check

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIXTURE_HOST = '127.0.0.1';
export const DEFAULT_FIXTURE_PORT = 4173;
export const FIXTURE_PORT_ENV = 'BBX_FIXTURE_PORT';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const staticRoutes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/assets/app.js', ['assets/app.js', 'text/javascript; charset=utf-8']],
  ['/assets/styles.css', ['assets/styles.css', 'text/css; charset=utf-8']],
  ['/assets/fixture.svg', ['assets/fixture.svg', 'image/svg+xml']],
]);

/**
 * @param {string | undefined} value
 * @returns {number}
 */
export function parseFixturePort(value) {
  if (value === undefined || value === '') {
    return DEFAULT_FIXTURE_PORT;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `Fixture port must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`
    );
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Fixture port must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`
    );
  }
  return port;
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {string | Uint8Array} body
 * @param {string} contentType
 * @param {Record<string, string>} [headers]
 */
function send(response, status, body, contentType, headers = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {Record<string, unknown>} value
 * @param {Record<string, string>} [headers]
 */
function sendJson(response, status, value, headers) {
  send(response, status, `${JSON.stringify(value)}\n`, 'application/json; charset=utf-8', headers);
}

/** @param {string} text */
function websocketTextFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length >= 126) {
    throw new Error('Fixture WebSocket payload exceeded its single-frame limit.');
  }
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:net').Socket} socket
 */
function handleWebSocketUpgrade(request, socket) {
  if (request.url !== '/ws') {
    socket.destroy();
    return;
  }
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n')
  );
  socket.write(websocketTextFrame('fixture-websocket-open'));
  socket.setTimeout(2_000, () => socket.destroy());
  socket.once('data', () => socket.end());
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
async function handleRequest(request, response) {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(response, 405, { error: 'method-not-allowed' }, { Allow: 'GET, HEAD' });
    return;
  }

  const url = new URL(request.url ?? '/', `http://${FIXTURE_HOST}`);
  const staticRoute = staticRoutes.get(url.pathname);
  if (staticRoute) {
    const [relativePath, contentType] = staticRoute;
    const body = await readFile(path.join(fixtureRoot, relativePath));
    send(response, 200, method === 'HEAD' ? '' : body, contentType);
    return;
  }

  if (url.pathname === '/redirect') {
    response.writeHead(302, {
      'Cache-Control': 'no-store',
      Location: '/?redirected=1#redirect-complete',
    });
    response.end();
    return;
  }

  if (url.pathname === '/resource/fetch') {
    sendJson(response, 200, { fixture: 'fetch', ok: true });
    return;
  }
  if (url.pathname === '/resource/xhr') {
    sendJson(response, 200, { fixture: 'xhr', ok: true });
    return;
  }
  if (url.pathname === '/resource/cache') {
    const etag = '"fixture-cache-v1"';
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { 'Cache-Control': 'public, max-age=60', ETag: etag });
      response.end();
      return;
    }
    send(response, 200, 'fixture-cache-v1\n', 'text/plain; charset=utf-8', {
      'Cache-Control': 'public, max-age=60',
      ETag: etag,
    });
    return;
  }
  if (url.pathname === '/resource/slow') {
    const requestedDelay = Number(url.searchParams.get('delay') ?? 300);
    const delay = Number.isFinite(requestedDelay)
      ? Math.min(1_000, Math.max(0, Math.trunc(requestedDelay)))
      : 300;
    setTimeout(() => sendJson(response, 200, { fixture: 'slow', delay }), delay);
    return;
  }
  if (url.pathname === '/resource/fail') {
    sendJson(response, 503, { error: 'fixture-intentional-failure' });
    return;
  }
  if (url.pathname === '/resource/abort') {
    request.socket.destroy();
    return;
  }
  if (url.pathname === '/resource/dynamic.js') {
    send(
      response,
      200,
      "window.fixtureDynamicScriptLoaded = true; window.dispatchEvent(new Event('fixture-dynamic-script'));\n",
      'text/javascript; charset=utf-8'
    );
    return;
  }
  if (url.pathname === '/resource/dynamic.svg') {
    send(
      response,
      200,
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#c2410c"/></svg>\n',
      'image/svg+xml'
    );
    return;
  }

  sendJson(response, 404, { error: 'fixture-route-not-found', path: url.pathname });
}

/** @returns {import('node:http').Server} */
export function createFixtureServer() {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'fixture-server-error' });
      } else {
        response.destroy();
      }
      console.error(`Browser reliability fixture request failed: ${error.message}`);
    });
  });
  server.on('upgrade', handleWebSocketUpgrade);
  return server;
}

/**
 * @param {{ port?: number }} [options]
 * @returns {Promise<{ server: import('node:http').Server, port: number, origin: string }>}
 */
export async function startFixtureServer(options = {}) {
  const port = options.port ?? DEFAULT_FIXTURE_PORT;
  const server = createFixtureServer();
  await new Promise((resolve, reject) => {
    const onError = (/** @type {Error} */ error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(undefined);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, FIXTURE_HOST);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('Fixture server did not expose a TCP address.');
  }
  return {
    server,
    port: address.port,
    origin: `http://${FIXTURE_HOST}:${address.port}`,
  };
}

/** @param {string[]} args */
function readCliPort(args) {
  let value = process.env[FIXTURE_PORT_ENV];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--port' || index + 1 >= args.length) {
      throw new Error('Usage: npm run fixture:browser -- --port <1-65535>');
    }
    value = args[index + 1];
    index += 1;
  }
  return parseFixturePort(value);
}

async function runCli() {
  const port = readCliPort(process.argv.slice(2));
  let running;
  try {
    running = await startFixtureServer({ port });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not start browser reliability fixture on ${FIXTURE_HOST}:${port}: ${detail}`
    );
  }
  console.log(`Browser reliability fixture: ${running.origin}/`);
  console.log(`Local-only listener: ${FIXTURE_HOST}:${running.port} (Ctrl+C to stop)`);

  const shutdown = () => running.server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryPath === import.meta.url) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
