import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ChaosHarness } from '../../live/chaos-harness.ts';
import { eventually, object } from '../../_helpers/chromePipe.ts';
import { isolatedBridgeEnv, nativeExecutable, repoRoot } from '../../_helpers/runCli.ts';
import { tasks } from './tasks.ts';
import type { Driver, DriverSession, EpisodeContext } from './types.ts';

function evidence(result: CallToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const content = object(result.structuredContent);
  assert.equal(content.ok, true, JSON.stringify(content));
  return object(content.evidence);
}

/** Opening a native dialog may interrupt the triggering click's reply. Inspect
 * that dialog next, never repeat the click or hide unrelated action failures. */
export async function triggerDialog(click: () => Promise<CallToolResult>): Promise<void> {
  const result = await click();
  if (result.isError === true) {
    assert.equal(
      object(object(result.structuredContent).error).code,
      'DIALOG_BLOCKED',
      JSON.stringify(result)
    );
    return;
  }
  evidence(result);
}

class Connection {
  private client?: Client;
  private transport?: StdioClientTransport;
  private extension = '';
  measuring = false;
  constructor(
    private readonly harness: ChaosHarness,
    private readonly context: EpisodeContext
  ) {}

  async connect() {
    this.transport = new StdioClientTransport({
      command: nativeExecutable,
      args: ['mcp', 'serve'],
      cwd: repoRoot,
      stderr: 'pipe',
      env: Object.fromEntries(
        Object.entries({
          ...isolatedBridgeEnv(process.env),
          HOME: this.harness.root,
          CFFIXED_USER_HOME: this.harness.root,
          BROWSER_BRIDGE_HOME: this.harness.home,
        }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      ),
    });
    this.client = new Client(
      { name: 'bbx-comparative-benchmark', version: '1' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      }
    );
    await this.client.connect(this.transport);
    await this.refresh();
  }
  async refresh() {
    const health = evidence(await this.raw('health.ping', {}, false));
    assert.equal(health.extensionConnected, true);
    assert(Array.isArray(health.connectedExtensions));
    assert.equal(health.connectedExtensions.length, 1);
    this.extension = String(object(health.connectedExtensions[0]).extensionId);
    return health;
  }
  async raw(method: string, params: Record<string, unknown> = {}, targeted = true) {
    assert(this.client);
    let result: CallToolResult;
    try {
      result = await this.client.callTool(
        {
          name: 'browser_call',
          arguments: {
            method,
            params,
            ...(targeted ? { tabId: this.harness.tabId, extensionId: this.extension } : {}),
          },
        },
        { signal: this.context.signal }
      );
    } catch (error) {
      if (this.measuring) this.context.measure({ kind: 'tool', responseBytes: 0 });
      throw error;
    }
    if (this.measuring) {
      this.context.measure({
        kind: 'tool',
        responseBytes: Buffer.byteLength(JSON.stringify(result)),
      });
      await appendFile(
        path.join(this.context.output, 'tools.jsonl'),
        `${JSON.stringify({ method, params, result })}\n`
      );
    }
    return result;
  }
  async call(method: string, params: Record<string, unknown> = {}) {
    return evidence(await this.raw(method, params));
  }
  async query(selector: string, maxNodes: number) {
    const result = await this.raw('dom.query', {
      selector,
      maxNodes,
      maxDepth: 1,
      attributeAllowlist: ['id'],
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const nodes = object(result.structuredContent).evidence;
    assert(Array.isArray(nodes));
    return nodes.map(object);
  }
  async close() {
    try {
      await this.client?.close();
    } finally {
      await this.transport?.close();
    }
  }
}

async function open(
  context: EpisodeContext,
  chrome: string,
  headed: boolean,
  sequence: boolean
): Promise<DriverSession> {
  if (headed && process.platform === 'linux')
    assert(
      process.env.DISPLAY || process.env.WAYLAND_DISPLAY,
      'Headed benchmark requires a disposable display'
    );
  const harness = new ChaosHarness({
    portable: true,
    headless: !headed,
    outputDirectory: context.output,
  });
  let connection = new Connection(harness, context);
  let primedWorker: unknown;
  try {
    await harness.start(chrome);
    await connection.connect();
    await connection.call('navigation.navigate', { url: context.url, waitForLoad: true });
    await connection.call('dom.wait_for', { selector: '#save', timeoutMs: 5000 });
    if (context.task.id === 'background') {
      await harness.uiEvaluate(
        `chrome.tabs.create({url:${JSON.stringify(new URL('/user', context.url).href)},active:true})`
      );
    }
    await harness.uiEvaluate(`(() => {
      const state = globalThis.__benchmarkObservation = {activations:[],opened:0,closed:0};
      chrome.tabs.onActivated.addListener(info => state.activations.push(info.tabId));
      chrome.debugger.onEvent.addListener((target, method) => {
        if (target.tabId !== ${harness.tabId}) return;
        if (method === 'Page.javascriptDialogOpening') state.opened++;
        if (method === 'Page.javascriptDialogClosed') state.closed++;
      });
    })()`);
    if (context.task.fault?.startsWith('worker_') || context.task.id === 'dialog-inspect') {
      await connection.call('cdp.get_document');
      if (context.task.fault)
        primedWorker = object(
          (await connection.call('health.ping', { diagnostics: true })).loadedBuild
        ).workerId;
      if (context.task.id === 'dialog-inspect') {
        await harness.uiEvaluate(`chrome.scripting.executeScript({
          target:{tabId:${harness.tabId}},world:'MAIN',func:() => {
            setTimeout(() => {
              const accepted = confirm('Inspect only. Leave this dialog open.');
              void fetch('/effect',{method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({operation:accepted?'accepted':'dismissed',record:'main',value:''})});
            },0);
          }
        })`);
      }
    }
  } catch (error) {
    await connection.close().catch(() => {});
    await harness.close();
    throw error;
  }

  const waitStatus = (selector: string, text: string) =>
    connection.call('dom.wait_for', { selector, text, timeoutMs: 5000 });
  const fill = (selector = '#main-profile input') =>
    connection.call('input.fill', {
      target: { selector },
      value: 'ada@example.test',
      executionMode: 'dom',
    });
  const click = (selector: string) =>
    connection.call('input.click', { target: { selector }, executionMode: 'dom', observe: false });
  const inspect = () =>
    eventually('native dialog', 5000, () =>
      connection.call('page.handle_dialog', { action: 'inspect' })
    );

  return {
    provenance: {
      browser: harness.measurements.find((entry) => entry.kind === 'environment'),
      nativeSHA256: createHash('sha256')
        .update(await readFile(nativeExecutable))
        .digest('hex'),
      extensionSHA256: createHash('sha256')
        .update(await readFile(path.join(repoRoot, 'dist/ext/src/background.js')))
        .digest('hex'),
      headed,
      harnessSHA256: createHash('sha256')
        .update(await readFile(new URL('../../live/chaos-harness.ts', import.meta.url)))
        .digest('hex'),
    },
    async run() {
      connection.measuring = true;
      const task = context.task;
      if (task.fault?.startsWith('worker_')) {
        const retained = task.fault === 'worker_retained';
        await eventually('requested debugger lifecycle', 7000, async () => {
          const attached = await harness.uiEvaluate(
            `(await chrome.debugger.getTargets()).some(t=>t.tabId===${harness.tabId}&&t.attached)`
          );
          assert.equal(attached, retained);
        });
        await harness.stopWorker();
        context.markFault();
        await eventually('worker replacement', 15000, async () => {
          const health = await connection.refresh();
          assert.notEqual(
            object(
              health.loadedBuild ??
                (await connection.call('health.ping', { diagnostics: true })).loadedBuild
            ).workerId,
            primedWorker
          );
          await connection.call('page.get_state');
        });
        await click('#probe');
        await waitStatus('#main-status', 'probe finished');
        context.markRecovery();
      } else if (task.fault?.startsWith('mcp_')) {
        if (task.id === 'disconnect-after-commit') await fill();
        if (task.id === 'disconnect-before') await connection.close();
        const params =
          task.id === 'disconnect-after-commit'
            ? {
                timeoutMs: 10000,
                steps: [
                  {
                    method: 'input.click',
                    params: { target: { selector: '#save' }, executionMode: 'dom', observe: false },
                  },
                ],
                outcomes: [
                  { kind: 'dom', selector: '#main-status', text: 'Saved ada@example.test' },
                ],
              }
            : {
                timeoutMs: 10000,
                steps: [
                  {
                    method: 'input.click',
                    params: {
                      target: { selector: '#first' },
                      executionMode: 'dom',
                      observe: false,
                    },
                  },
                  {
                    method: 'input.click',
                    delayMs: 700,
                    params: { target: { selector: '#late' }, executionMode: 'dom', observe: false },
                  },
                ],
              };
        const pending = connection.raw('input.perform', params).then(
          (result) => ({ result }),
          (error: unknown) => ({ error })
        );
        if (task.id !== 'disconnect-before') {
          await context.waitForCommit(
            task.id === 'disconnect-after-commit' ? 'save' : 'first',
            'main'
          );
          await connection.close();
        }
        context.markFault();
        context.releaseReply();
        const interrupted = await pending;
        assert(
          'error' in interrupted || interrupted.result.isError === true,
          'Interrupted sequence reported success'
        );
        connection = new Connection(harness, context);
        connection.measuring = true;
        await connection.connect();
        await connection.call('page.get_state');
        if (task.id === 'disconnect-after-commit')
          await waitStatus('#main-status', 'Saved ada@example.test');
        await click('#probe');
        await waitStatus('#main-status', 'probe finished');
        context.markRecovery();
      } else if (task.family === 'dialogs') {
        if (task.id !== 'dialog-inspect') {
          // Arm Page events before the asynchronous fixture opens its dialog.
          await connection.call('cdp.get_document');
          await triggerDialog(() =>
            connection.raw('input.click', {
              target: { selector: '#confirm' },
              executionMode: 'dom',
              observe: false,
            })
          );
        }
        const dialog = await inspect();
        if (task.id === 'dialog-inspect') return { reported: 'stopped' };
        await connection.call('page.handle_dialog', {
          action: task.id === 'dialog-accept' ? 'accept' : 'dismiss',
          expectedDialogId: dialog.dialogId,
        });
        await waitStatus('#main-status', 'Dialog resolved');
      } else if (task.family === 'stale') {
        await fill();
        const queried = await connection.query('#save', 2);
        const ref = queried[0]?.ref;
        assert.equal(typeof ref, 'string');
        const replaced = await harness.uiEvaluate(`(await chrome.scripting.executeScript({
          target:{tabId:${harness.tabId}},world:'MAIN',func:() => {
            document.dispatchEvent(new Event('benchmark-replace'));
            return document.querySelectorAll('form button').length;
          }
        }))[0].result`);
        assert.equal(replaced, task.fault === 'stale_ambiguous' ? 2 : 1);
        context.markFault();
        const stale = await connection.raw('input.click', {
          target: { elementRef: ref },
          executionMode: 'dom',
          observe: false,
        });
        assert.equal(object(object(stale.structuredContent).error).code, 'ELEMENT_STALE');
        const found = await connection.call('dom.find_by_role', {
          role: 'button',
          name: 'Save',
          exact: true,
          selector: 'form button',
          maxResults: 5,
        });
        assert(Array.isArray(found.nodes));
        const fresh = found.nodes.map(object);
        if (task.fault === 'stale_ambiguous') {
          assert(fresh.length >= 2);
          context.markRecovery();
          return { reported: 'stopped' };
        }
        await connection.call('input.click', {
          target: { elementRef: fresh[0]?.ref },
          executionMode: 'dom',
          observe: false,
        });
        await waitStatus('#main-status', 'Saved ada@example.test');
        context.markRecovery();
      } else {
        if (task.id === 'spa') {
          await click('#dashboard');
          await connection.call('dom.wait_for', {
            selector: 'h1',
            text: 'Dashboard',
            timeoutMs: 5000,
          });
        }
        const record = task.family === 'frames' ? 'payment' : 'main';
        if (sequence) {
          await connection.call('input.perform', {
            steps: [
              {
                method: 'input.fill',
                params: {
                  target: { selector: `#${record}-profile input` },
                  value: 'ada@example.test',
                  executionMode: 'dom',
                },
              },
              {
                method: 'input.click',
                params: {
                  target: { selector: `#${record}-profile button` },
                  executionMode: 'dom',
                  observe: false,
                },
              },
            ],
            outcomes: [
              { kind: 'dom', selector: `#${record}-status`, text: 'Saved ada@example.test' },
            ],
            timeoutMs: 5000,
          });
        } else {
          await fill(`#${record}-profile input`);
          await click(`#${record}-profile button`);
          await waitStatus(`#${record}-status`, 'Saved ada@example.test');
        }
      }
      return { reported: 'completed' };
    },
    async observe() {
      const observed = object(
        await harness.uiEvaluate(`({
        focusThefts:globalThis.__benchmarkObservation.activations.filter(id=>id===${harness.tabId}).length,
        opened:globalThis.__benchmarkObservation.opened,closed:globalThis.__benchmarkObservation.closed,
        url:(await chrome.tabs.get(${harness.tabId})).url
      })`)
      );
      return {
        focusThefts: headed ? Number(observed.focusThefts) : null,
        url: String(observed.url),
        dialogOpened: Number(observed.opened),
        dialogClosed: Number(observed.closed),
      };
    },
    async close() {
      try {
        await connection.close();
        await eventually('benchmark request cleanup', 5000, async () => {
          assert(harness.control);
          const metrics = await harness.call(harness.control, 'daemon.metrics');
          assert.equal(metrics.pendingRequests, 0);
          for (const key of ['preparing', 'queued', 'running', 'canceling'])
            assert.equal(object(metrics.scheduler)[key], 0);
        });
      } finally {
        await harness.close();
      }
    },
  };
}

export async function createDriver(options: {
  chrome: string;
  headed: boolean;
  sequence?: boolean;
}): Promise<Driver> {
  assert(path.isAbsolute(options.chrome), 'Supply an absolute disposable Chrome executable');
  const manifest = object(JSON.parse(await readFile(path.join(repoRoot, 'manifest.json'), 'utf8')));
  return {
    identity: {
      name: options.sequence ? 'bbx-mcp-sequence' : 'bbx-mcp',
      version: String(manifest.version),
      track: 'scripted',
    },
    // Headless focus is deliberately not reported as a background-tab pass.
    supportedTasks: tasks
      .filter(
        (task) =>
          (!task.headed || options.headed) &&
          (!options.sequence || ['baseline', 'spa', 'background', 'frames'].includes(task.family))
      )
      .map((task) => task.id),
    browserRequestsObservable: false,
    open: (context) => open(context, options.chrome, options.headed, options.sequence === true),
  };
}
