import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ChromePipe } from './chromePipe.ts';
import { extensionFile } from './extensionBuild.ts';

/** Production content scripts in their injection order. */
export const CONTENT_SCRIPT_FILES = Object.freeze([
  'content-script-helpers.js',
  'content-dom-baseline.js',
  'content-element-registry.js',
  'content-dom-query.js',
  'content-input.js',
  'content-patch.js',
  'content-script.js',
]);

/** Skip reason for tests that need a real Chrome, or false when one is configured. */
export const chromeSkipReason: string | false =
  !process.env.BBX_TEST_CHROME && 'Set BBX_TEST_CHROME to a Chrome/Chromium executable';

/**
 * Run a self-contained check in headless Chrome with the built content scripts
 * loaded. The check must throw to fail; its error text is returned as the DOM.
 */
export async function runContentCheckInChrome(
  check: () => Promise<void>,
  options: { virtualTimeBudgetMs?: number; extraArgs?: string[] } = {}
): Promise<{ passed: boolean; output: string }> {
  const executable = process.env.BBX_TEST_CHROME;
  if (!executable) throw new Error('BBX_TEST_CHROME is not set.');
  const profile = await mkdtemp(join(tmpdir(), 'bbx-content-test-'));
  const scripts = await Promise.all(
    CONTENT_SCRIPT_FILES.map((name) => readFile(extensionFile(`src/${name}`), 'utf8'))
  );
  // tsx preserves nested function names with this helper when serializing tests.
  const html = `<!doctype html><html><body><script>function __name(fn){return fn} globalThis.chrome={runtime:{onMessage:{addListener(fn){globalThis.__bbxListener=fn}}}};</script><script>${scripts.join('\n')}</script><script>
    (${check.toString()})().then(() => { document.body.dataset.result='passed'; }).catch(error => { document.body.dataset.result='failed'; document.body.textContent=error.stack || String(error); });
  </script></body></html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server has no port.');
    const { stdout } = await promisify(execFile)(
      executable,
      [
        '--headless',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--password-store=basic',
        '--use-mock-keychain',
        `--user-data-dir=${profile}`,
        `--virtual-time-budget=${options.virtualTimeBudgetMs ?? 5000}`,
        ...(options.extraArgs ?? []),
        '--dump-dom',
        `http://127.0.0.1:${address.port}/`,
      ],
      { timeout: 30_000, maxBuffer: 4_000_000 }
    );
    return { passed: /data-result="passed"/.test(stdout), output: stdout };
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(profile, { recursive: true, force: true });
  }
}

/**
 * Like runContentCheckInChrome, but in real time over a CDP pipe. Use it when
 * the check waits on browser I/O (IndexedDB) that virtual time would outrun.
 * The browser uses a fresh temporary profile and no listening port.
 */
export async function runContentCheckInChromeRealTime(
  check: () => Promise<void>,
  options: { timeoutMs?: number } = {}
): Promise<{ passed: boolean; output: string }> {
  const executable = process.env.BBX_TEST_CHROME;
  if (!executable) throw new Error('BBX_TEST_CHROME is not set.');
  const profile = await mkdtemp(join(tmpdir(), 'bbx-content-test-'));
  const scripts = await Promise.all(
    CONTENT_SCRIPT_FILES.map((name) => readFile(extensionFile(`src/${name}`), 'utf8'))
  );
  const html = `<!doctype html><html><body><script>function __name(fn){return fn} globalThis.chrome={runtime:{onMessage:{addListener(fn){globalThis.__bbxListener=fn}}}};</script><script>${scripts.join('\n')}</script><script>
    (${check.toString()})().then(() => { document.body.dataset.result='passed'; }).catch(error => { document.body.dataset.result='failed'; document.body.dataset.error=error.stack || String(error); });
  </script></body></html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chrome = spawn(
    executable,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--password-store=basic',
      '--use-mock-keychain',
      `--user-data-dir=${profile}`,
      '--remote-debugging-pipe',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
  );
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server has no port.');
    const pipe = new ChromePipe(chrome.stdio[3] as Writable, chrome.stdio[4] as Readable);
    await pipe.command('Browser.getVersion', {}, undefined, 15_000);
    const { targetId } = await pipe.command('Target.createTarget', {
      url: `http://127.0.0.1:${address.port}/`,
    });
    const { sessionId } = await pipe.command('Target.attachToTarget', { targetId, flatten: true });
    const deadline = Date.now() + (options.timeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      const evaluated = await pipe.command(
        'Runtime.evaluate',
        {
          expression: 'JSON.stringify(document.body ? document.body.dataset : {})',
          returnByValue: true,
        },
        String(sessionId)
      );
      const dataset = JSON.parse(
        String((evaluated.result as { value?: unknown } | undefined)?.value ?? '{}')
      ) as { result?: string; error?: string };
      if (dataset.result === 'passed') return { passed: true, output: '' };
      if (dataset.result === 'failed') return { passed: false, output: dataset.error ?? '' };
      await delay(100);
    }
    return { passed: false, output: 'The check did not finish in time.' };
  } finally {
    chrome.kill();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
}
