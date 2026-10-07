// @ts-check

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const INTERACTION_FIXTURE_HOST = '127.0.0.1';
export const DEFAULT_INTERACTION_FIXTURE_PORT = 4174;

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
/** SPA routes fall back to the page so pushState URLs survive reloads. */
const routes = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/dashboard', 'index.html'],
  ['/frame.html', 'frame.html'],
]);

/**
 * Serve the agent interaction fixture on the loopback interface only.
 *
 * @param {{ port?: number }} [options]
 * @returns {Promise<{ server: import('node:http').Server, origin: string }>}
 */
export async function startInteractionFixtureServer(options = {}) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    const file = routes.get(pathname);
    if (!file || request.method !== 'GET') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
      return;
    }
    const body = await readFile(path.join(fixtureRoot, file));
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_INTERACTION_FIXTURE_PORT, INTERACTION_FIXTURE_HOST, () =>
      resolve(undefined)
    );
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : options.port;
  return { server, origin: `http://${INTERACTION_FIXTURE_HOST}:${port}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { origin } = await startInteractionFixtureServer({
    port: Number(process.env.BBX_FIXTURE_PORT) || DEFAULT_INTERACTION_FIXTURE_PORT,
  });
  process.stdout.write(`Agent interaction fixture: ${origin}/\n`);
}
