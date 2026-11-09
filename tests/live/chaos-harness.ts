import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ChromePipe, eventually, object } from '../_helpers/chromePipe.ts';
import { NativeWireClient } from '../_helpers/nativeWire.ts';
import { isolatedBridgeEnv, nativeExecutable, repoRoot } from '../_helpers/runCli.ts';
import { setProtocolPackageVersion } from '../_helpers/protocolVersion.ts';
import type { BridgeMethod } from '../../protocol/types.ts';

const fixture = `<!doctype html><meta charset="utf-8"><title>BBX disposable chaos fixture</title>
<button id="first" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1)">First</button>
<button id="late" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1)">Must not run after disconnect</button>
<button id="probe" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1)">Recovery probe</button>`;

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function positiveSetting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  assert(Number.isInteger(value) && value >= min && value <= max, `${name} must be ${min}..${max}`);
  return value;
}

/** Linux-only: both Chrome's registry and Go's home are redirected into this run.
 * Never installs into the user's real browser or connects to an existing daemon. */
export class ChaosHarness {
  root = '';
  readonly output = path.join(
    repoRoot,
    'dist',
    'chaos-live',
    `${Date.now()}-${randomUUID().slice(0, 8)}`
  );
  readonly clients = new Set<NativeWireClient>();
  readonly measurements: Array<Record<string, unknown>> = [];
  private readonly children: ChildProcess[] = [];
  private server?: Server;
  private chrome?: ChildProcess;
  private pipe?: ChromePipe;
  private ui = '';
  private extension = '';
  private token = '';
  private executable = '';
  private baselineTargets: string[] = [];
  private baselineFds = 0;
  private baselinePid = 0;
  tabId = 0;
  control?: NativeWireClient;

  get cdp() {
    assert(this.pipe);
    return this.pipe;
  }
  get home() {
    return path.join(this.root, 'bridge');
  }

  async start(chromeExecutable: string) {
    assert.equal(process.platform, 'linux', 'Native-host isolation currently requires Linux');
    assert(
      process.env.DISPLAY || process.env.WAYLAND_DISPLAY,
      'Use a disposable display, e.g. xvfb-run'
    );
    this.executable = await realpath(nativeExecutable);
    await mkdir(this.output, { recursive: true });
    this.root = await mkdtemp(path.join(os.tmpdir(), 'bbx-chaos-'));
    await mkdir(this.home);
    const env = {
      ...isolatedBridgeEnv(process.env),
      HOME: this.root,
      XDG_CONFIG_HOME: path.join(this.root, 'config'),
      CHROME_CONFIG_HOME: path.join(this.root, 'config'),
      XDG_DATA_HOME: path.join(this.root, 'data'),
      XDG_CACHE_HOME: path.join(this.root, 'cache'),
      XDG_STATE_HOME: path.join(this.root, 'state'),
      BROWSER_BRIDGE_HOME: this.home,
    };
    // A private extension key gives this copied build its own stable ID.
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = publicKey.export({ type: 'spki', format: 'der' });
    this.extension = [...createHash('sha256').update(key).digest().subarray(0, 16)]
      .flatMap((byte) => [byte >> 4, byte & 15])
      .map((nibble) => String.fromCharCode(97 + nibble))
      .join('');
    const extensionPath = path.join(this.root, 'extension');
    await cp(path.join(repoRoot, 'dist/ext'), extensionPath, { recursive: true });
    const manifestPath = path.join(extensionPath, 'manifest.json');
    const manifest = object(JSON.parse(await readFile(manifestPath, 'utf8')));
    setProtocolPackageVersion(String(manifest.version));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, key: key.toString('base64') }));
    const launcher = path.join(this.root, 'native-host.sh');
    await writeFile(
      launcher,
      `#!/bin/sh\nexport BROWSER_BRIDGE_HOME=${quote(this.home)}\nexec ${quote(this.executable)} --native-host "$@"\n`,
      { mode: 0o700 }
    );
    const targets = object(
      JSON.parse(await readFile(path.join(repoRoot, 'protocol/install-targets.json'), 'utf8'))
    );
    assert(Array.isArray(targets.browsers));
    const profile = path.join(this.root, 'profile');
    // Chromium variants may derive this path from the default config directory
    // or --user-data-dir. All candidates remain inside the disposable root.
    for (const directory of [
      profile,
      ...targets.browsers.map((entry) =>
        path.join(env.XDG_CONFIG_HOME, String(object(entry).linuxDir))
      ),
    ]) {
      const hosts = path.join(directory, 'NativeMessagingHosts');
      await mkdir(hosts, { recursive: true });
      await writeFile(
        path.join(hosts, `${targets.hostName}.json`),
        JSON.stringify({
          name: targets.hostName,
          description: 'BBX isolated chaos test',
          path: launcher,
          type: 'stdio',
          allowed_origins: [`chrome-extension://${this.extension}/`],
        })
      );
    }
    this.server = createServer((request, response) => {
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
      );
      if (request.url !== '/') {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(fixture);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/`;
    this.launch(this.executable, ['--bridge-daemon'], env, 'initial-daemon.log');
    await eventually('daemon startup', 10_000, async (remaining) => {
      this.token = (await readFile(path.join(this.home, 'daemon.auth'), 'utf8')).trim();
      this.control = await this.connect(Math.min(remaining, 1000));
    });
    this.chrome = this.launch(
      chromeExecutable,
      [
        `--user-data-dir=${profile}`,
        `--load-extension=${extensionPath}`,
        `--disable-extensions-except=${extensionPath}`,
        '--remote-debugging-pipe',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        url,
      ],
      env,
      'chrome.log',
      true
    );
    const input = this.chrome.stdio[3] as Writable;
    const output = this.chrome.stdio[4] as Readable;
    this.pipe = new ChromePipe(input, output);
    this.measurements.push({
      kind: 'environment',
      node: process.version,
      architecture: process.arch,
      browser: await this.cdp.command('Browser.getVersion'),
    });
    const opened = await this.cdp.command('Target.createTarget', {
      url: `chrome-extension://${this.extension}/ui/sidepanel.html`,
    });
    const attached = await this.cdp.command('Target.attachToTarget', {
      targetId: opened.targetId,
      flatten: true,
    });
    this.ui = String(attached.sessionId);
    await eventually('extension startup', 15_000, async (remaining) => {
      this.tabId = Number(
        await this.uiEvaluate(
          `(await chrome.tabs.query({})).find(tab => tab.url === ${JSON.stringify(url)})?.id`,
          remaining
        )
      );
      assert(this.tabId > 0);
    });
    // Exercise the shipped extension's UI-port access flow, not worker globals.
    await this.uiEvaluate(`(() => {
      const port = chrome.runtime.connect({name:'ui-sidepanel'});
      port.postMessage({type:'state.request',scopeTabId:${this.tabId}});
      port.postMessage({type:'scope.set_enabled',tabId:${this.tabId},enabled:true});
      setTimeout(() => port.disconnect(), 500);
    })()`);
    // Chrome rejects native pointer input in inactive tabs. Only this disposable
    // fixture is activated; the inspector stays attached to the extension UI.
    await this.uiEvaluate(`chrome.tabs.update(${this.tabId}, {active:true})`);
    await this.recover(20_000);
    await this.clean(10_000);
    this.baselineTargets = await this.pageTargets();
    this.baselinePid = await this.daemonPid();
    this.baselineFds = (await readdir(`/proc/${this.baselinePid}/fd`)).length;
  }

  private launch(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    logName: string,
    chrome = false
  ) {
    const log = createWriteStream(path.join(this.output, logName), { mode: 0o600 });
    const child = spawn(executable, args, {
      env,
      cwd: this.root,
      detached: true,
      stdio: chrome ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.pipe(log);
    child.on('error', (error) => {
      log.end(String(error));
      this.pipe?.close(error);
    });
    this.children.push(child);
    return child;
  }

  async connect(timeoutMs = 3000) {
    const client = await NativeWireClient.connect(
      path.join(this.home, 'bridge.sock'),
      this.token,
      randomUUID(),
      timeoutMs
    );
    this.clients.add(client);
    return client;
  }

  async call(
    client: NativeWireClient,
    method: BridgeMethod,
    params: Record<string, unknown> = {},
    timeoutMs = 3000
  ) {
    const response = await client.request(
      { method, params, tab_id: this.tabId || null },
      timeoutMs
    );
    assert(response.ok, JSON.stringify(response.error));
    return object(response.result);
  }

  async uiEvaluate(expression: string, timeoutMs = 3000) {
    const result = await this.cdp.command(
      'Runtime.evaluate',
      {
        expression: `(async () => (${expression}))()`,
        awaitPromise: true,
        returnByValue: true,
      },
      this.ui,
      timeoutMs
    );
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return object(result.result).value;
  }

  async state(timeoutMs = 3000) {
    return object(
      await this.uiEvaluate(
        `(await chrome.scripting.executeScript({
      target:{tabId:${this.tabId}},func:() => Object.fromEntries(['first','late','probe'].map(id => [id,Number(document.getElementById(id)?.dataset.count || 0)]))
    }))[0].result`,
        timeoutMs
      )
    );
  }

  async recover(timeoutMs: number) {
    const started = performance.now();
    const budget = () => {
      const remaining = timeoutMs - (performance.now() - started);
      assert(remaining > 0, 'Recovery deadline elapsed');
      return Math.max(1, Math.floor(remaining));
    };
    // Connection IDs change after reconnect; there is exactly one private peer.
    await eventually('bridge recovery', timeoutMs, async (remaining) => {
      if (!this.control) this.control = await this.connect(Math.min(remaining, 1000));
      try {
        const health = await this.call(this.control, 'health.ping', {}, Math.min(budget(), 1000));
        assert.equal(object(health.access).enabled, true);
        await this.call(this.control, 'page.get_state', {}, Math.min(budget(), 1000));
      } catch (error) {
        await this.control.close();
        this.clients.delete(this.control);
        this.control = undefined;
        throw error;
      }
    });
    assert(this.control);
    const before = Number((await this.state(budget())).probe);
    await this.call(
      this.control,
      'input.click',
      { target: { selector: '#probe' }, executionMode: 'dom', observe: false },
      budget()
    );
    assert.equal(
      (await this.state(budget())).probe,
      before + 1,
      'Recovery must include a verified browser mutation'
    );
    assert(performance.now() - started <= timeoutMs, 'Recovery exceeded deadline');
    return Math.round(performance.now() - started);
  }

  async daemonPid() {
    const pid = Number((await readFile(path.join(this.home, 'daemon.pid'), 'utf8')).trim());
    assert(Number.isInteger(pid) && pid > 1);
    assert.equal(await readlink(`/proc/${pid}/exe`), this.executable);
    assert(
      (await readFile(`/proc/${pid}/environ`, 'utf8'))
        .split('\0')
        .includes(`BROWSER_BRIDGE_HOME=${this.home}`)
    );
    return pid;
  }

  async killDaemon() {
    const pid = await this.daemonPid();
    process.kill(pid, 'SIGKILL');
    if (this.control) {
      await this.control.close();
      this.clients.delete(this.control);
      this.control = undefined;
    }
    return pid;
  }

  async stopWorker() {
    const versions = new Map<string, Record<string, unknown>>();
    const listener = (params: unknown) => {
      const entries = object(params).versions;
      assert(Array.isArray(entries));
      for (const entry of entries) {
        const version = object(entry);
        versions.set(String(version.versionId), version);
      }
    };
    this.cdp.on('ServiceWorker.workerVersionUpdated', listener);
    try {
      await this.cdp.command('ServiceWorker.enable', {}, this.ui);
      const version = await eventually('running MV3 worker', 5000, async () => {
        const found = [...versions.values()].find(
          (entry) =>
            String(entry.scriptURL).startsWith(`chrome-extension://${this.extension}/`) &&
            entry.runningStatus === 'running'
        );
        assert(found, 'No running extension worker version reported');
        return found;
      });
      assert(this.control);
      const before = object(
        (await this.call(this.control, 'health.ping', { diagnostics: true })).loadedBuild
      ).workerId;
      await this.cdp.command('ServiceWorker.stopWorker', { versionId: version.versionId }, this.ui);
      return before;
    } finally {
      this.cdp.off('ServiceWorker.workerVersionUpdated', listener);
      await this.cdp.command('ServiceWorker.disable', {}, this.ui);
    }
  }

  async pageTargets(timeoutMs = 3000) {
    const targets = (await this.cdp.command('Target.getTargets', {}, undefined, timeoutMs))
      .targetInfos;
    assert(Array.isArray(targets));
    return targets
      .map(object)
      .filter((entry) => entry.type === 'page')
      .map((entry) => String(entry.targetId))
      .sort();
  }

  async nativeProcesses() {
    const found: number[] = [];
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if ((await readlink(`/proc/${entry}/exe`)) !== this.executable) continue;
        if (
          (await readFile(`/proc/${entry}/environ`, 'utf8'))
            .split('\0')
            .includes(`BROWSER_BRIDGE_HOME=${this.home}`)
        )
          found.push(Number(entry));
      } catch {
        /* A process may exit while /proc is being sampled. */
      }
    }
    return found;
  }

  async clean(timeoutMs: number) {
    const deadline = performance.now() + timeoutMs;
    const budget = () => {
      const remaining = deadline - performance.now();
      assert(remaining > 0, 'Resource cleanup deadline elapsed');
      return Math.max(1, Math.floor(remaining));
    };
    await eventually('resource cleanup', timeoutMs, async () => {
      assert(this.control);
      const metrics = await this.call(this.control, 'daemon.metrics', {}, Math.min(budget(), 2000));
      assert.equal(metrics.activeAgents, 1, 'Leaked agent connection');
      assert.equal(metrics.activeExtensions, 1, 'Duplicate native-host connection');
      assert.equal(metrics.pendingRequests, 0, 'Leaked request');
      const scheduler = object(metrics.scheduler);
      for (const key of ['preparing', 'queued', 'running', 'canceling'])
        assert.equal(scheduler[key], 0, `Leaked scheduler ${key}`);
      const health = await this.call(
        this.control,
        'health.ping',
        { diagnostics: true },
        Math.min(budget(), 2000)
      );
      const debuggerState = object(health.debugger);
      for (const key of ['attachedTabCount', 'heldTabCount', 'pendingTabCount'])
        assert.equal(debuggerState[key], 0, `Leaked debugger ${key}`);
      const capture = object(health.capture);
      for (const key of [
        'activeTabCount',
        'ownershipCount',
        'inflightCount',
        'interceptionActiveTabCount',
        'interceptionRuleCount',
      ])
        assert.equal(capture[key], 0, `Leaked capture ${key}`);
      const targets = await this.uiEvaluate(
        `(await chrome.debugger.getTargets()).filter(target => target.tabId === ${this.tabId} && target.attached)`,
        budget()
      );
      assert.deepEqual(targets, [], 'Chrome still reports an attached fixture debugger');
      const recorder = await this.uiEvaluate(
        `(await chrome.scripting.executeScript({target:{tabId:${this.tabId}},func:() => Boolean(globalThis.__BBX_ACTIVITY_RECORDER__?.active)}))[0].result`,
        budget()
      );
      assert.equal(recorder, false, 'Leaked page activity recorder');
      assert.deepEqual(
        await readdir(path.join(this.home, 'artifacts')),
        [],
        'Leaked artifact files'
      );
      assert.equal(
        (await this.nativeProcesses()).length,
        2,
        'Expected one daemon and one native host'
      );
      if (this.baselineTargets.length)
        assert.deepEqual(
          await this.pageTargets(budget()),
          this.baselineTargets,
          'Leaked or lost browser tab'
        );
      const pid = await this.daemonPid();
      const fds = (await readdir(`/proc/${pid}/fd`)).length;
      if (pid === this.baselinePid)
        assert(fds <= this.baselineFds + 3, `Daemon fds grew from ${this.baselineFds} to ${fds}`);
      else {
        this.baselinePid = pid;
        this.baselineFds = fds;
      }
      this.measurements.push({
        kind: 'resources',
        metrics: {
          activeAgents: metrics.activeAgents,
          activeExtensions: metrics.activeExtensions,
          pendingRequests: metrics.pendingRequests,
          scheduler,
        },
        debugger: debuggerState,
        capture,
        nativeProcesses: 2,
        daemonPid: pid,
        daemonFds: fds,
      });
    });
  }

  async close() {
    const errors: unknown[] = [];
    for (const client of this.clients)
      await client.close().catch((error: unknown) => errors.push(error));
    this.clients.clear();
    this.pipe?.close();
    if (this.chrome?.pid) {
      try {
        process.kill(-this.chrome.pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error);
      }
      try {
        const group = this.chrome.pid;
        await eventually('Chrome process-group teardown', 5000, async () => {
          const live: number[] = [];
          for (const entry of await readdir('/proc')) {
            if (!/^\d+$/.test(entry)) continue;
            try {
              const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
              const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
              if (Number(fields[2]) === group && fields[0] !== 'Z') live.push(Number(entry));
            } catch {
              /* Process exited during sampling. */
            }
          }
          if (live.length) {
            try {
              process.kill(-group, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
          }
          assert.deepEqual(live, [], 'Owned Chrome processes remain alive');
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.root) {
      try {
        await eventually('native process teardown', 5000, async () => {
          for (const pid of await this.nativeProcesses()) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
          }
          assert.deepEqual(await this.nativeProcesses(), []);
        });
      } catch (error) {
        errors.push(error);
      }
    }
    for (const child of this.children) {
      try {
        await eventually('owned process teardown', 3000, async () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            throw new Error('Waiting for child exit');
          }
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.server) await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    if (this.root) {
      await cp(
        path.join(this.home, 'daemon.log'),
        path.join(this.output, 'reconnected-daemon.log')
      ).catch(() => {});
      await rm(this.root, { recursive: true, force: true });
    }
    if (errors.length) throw new AggregateError(errors, 'Disposable browser cleanup failed');
  }
}
