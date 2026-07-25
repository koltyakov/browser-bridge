import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createFailure, createSuccess } from '../protocol/src/index.js';
import { bridgeServerWith } from '../../tests/_helpers/socketHarness.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.resolve(__dirname, '../agent-client/src/cli.js');

const SKIP_ON_WINDOWS =
  process.platform === 'win32' ? 'Unix socket daemon test is not applicable on Windows' : false;

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type BatchItem = {
  method: string;
  ok: boolean;
  summary: string;
  error: { code: string; message: string } | null;
  response: unknown;
};

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseBatchOutput(result: ProcessResult): BatchItem[] {
  const parsed: unknown = JSON.parse(result.stdout.trim());
  assert.ok(Array.isArray(parsed), 'expected bbx batch to print a JSON array');
  return parsed as BatchItem[];
}

test(
  'bbx batch runs parallel read-only calls and returns ordered results',
  { skip: SKIP_ON_WINDOWS },
  async () => {
    const bridgeServer = await bridgeServerWith(
      {
        'page.get_state': (request) =>
          createSuccess(request.id, {
            url: 'https://example.com/',
            title: 'Example Domain',
            tabId: 7,
            readyState: 'complete',
          }),
        'dom.query': (request) =>
          createSuccess(request.id, {
            nodes: [{ elementRef: 'el_main', tagName: 'main', text: 'Batch target' }],
          }),
        'tabs.list': (request) =>
          createSuccess(request.id, {
            tabs: [{ tabId: 7, active: true, origin: 'https://example.com', title: 'Example' }],
          }),
      },
      { prefix: 'bbx-it-batch-' }
    );

    try {
      const batch = JSON.stringify([
        { method: 'page.get_state', params: {} },
        { method: 'dom.query', params: { selector: 'main' } },
        { method: 'tabs.list' },
      ]);
      const cliResult = await runCli(['batch', batch], {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      });

      assert.equal(cliResult.code, 0);
      assert.equal(cliResult.signal, null);
      const items = parseBatchOutput(cliResult);
      assert.deepEqual(
        items.map((item) => item.method),
        ['page.get_state', 'dom.query', 'tabs.list']
      );
      assert.ok(
        items.every((item) => item.ok),
        `expected all batch items to succeed: ${cliResult.stdout}`
      );
      assert.deepEqual(bridgeServer.requests.map((request) => request.method).sort(), [
        'dom.query',
        'page.get_state',
        'tabs.list',
      ]);
      assert.deepEqual(bridgeServer.errors, []);
    } finally {
      await bridgeServer.close();
    }
  }
);

test(
  'bbx batch isolates per-call failures and exits non-zero',
  { skip: SKIP_ON_WINDOWS },
  async () => {
    const bridgeServer = await bridgeServerWith(
      {
        'page.get_state': (request) =>
          createSuccess(request.id, {
            url: 'https://example.com/',
            title: 'Example Domain',
            tabId: 7,
            readyState: 'complete',
          }),
        'dom.query': (request) =>
          createFailure(request.id, 'ELEMENT_STALE', 'No element found matching selector.', null, {
            method: request.method,
          }),
      },
      { prefix: 'bbx-it-batch-err-' }
    );

    try {
      const batch = JSON.stringify([
        { method: 'dom.query', params: { selector: '#missing' } },
        { method: 'page.get_state', params: {} },
      ]);
      const cliResult = await runCli(['batch', batch], {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      });

      assert.equal(cliResult.code, 1);
      const items = parseBatchOutput(cliResult);
      assert.equal(items.length, 2);
      assert.equal(items[0].method, 'dom.query');
      assert.equal(items[0].ok, false);
      assert.equal(items[0].error?.code, 'ELEMENT_STALE');
      assert.equal(items[1].method, 'page.get_state');
      assert.equal(items[1].ok, true);
      assert.deepEqual(bridgeServer.requests.map((request) => request.method).sort(), [
        'dom.query',
        'page.get_state',
      ]);
      assert.deepEqual(bridgeServer.errors, []);
    } finally {
      await bridgeServer.close();
    }
  }
);

test(
  'bbx batch rejects unsafe methods without sending them to the daemon',
  { skip: SKIP_ON_WINDOWS },
  async () => {
    const bridgeServer = await bridgeServerWith(
      {
        'page.get_state': (request) =>
          createSuccess(request.id, { url: 'https://example.com/', tabId: 7 }),
      },
      { prefix: 'bbx-it-batch-unsafe-' }
    );

    try {
      const batch = JSON.stringify([
        { method: 'input.click', params: { elementRef: 'el_1' } },
        { method: 'page.get_state', params: {} },
      ]);
      const cliResult = await runCli(['batch', batch], {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      });

      assert.equal(cliResult.code, 1);
      const items = parseBatchOutput(cliResult);
      assert.equal(items.length, 2);
      assert.ok(items.every((item) => !item.ok));
      assert.ok(items.every((item) => item.error?.code === 'INVALID_REQUEST'));
      assert.match(String(items[0].error?.message), /not safe for batch execution/);
      assert.match(String(items[1].error?.message), /another call failed validation/);
      assert.deepEqual(
        bridgeServer.requests,
        [],
        'no bridge calls should be forwarded when batch validation fails'
      );
      assert.deepEqual(bridgeServer.errors, []);
    } finally {
      await bridgeServer.close();
    }
  }
);

test('bbx batch rejects malformed JSON input', { skip: SKIP_ON_WINDOWS }, async () => {
  const bridgeServer = await bridgeServerWith({}, { prefix: 'bbx-it-batch-json-' });

  try {
    const cliResult = await runCli(['batch', '{not json'], {
      ...process.env,
      BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
    });

    assert.equal(cliResult.code, 1);
    const payload = JSON.parse(cliResult.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.ok, false);
    assert.match(String(payload.summary), /Invalid JSON syntax/);
    assert.deepEqual(bridgeServer.requests, []);
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});
