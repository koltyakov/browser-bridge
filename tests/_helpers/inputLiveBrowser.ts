import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { createBackgroundInputController } from '../../packages/extension/src/background-input.js';
import { createRequest } from '../../protocol/src/index.js';
import type { BridgeMethod } from '../../protocol/src/types.js';
import { ChromePipe, object } from './chromePipe.ts';
import { extensionFile } from './extensionBuild.ts';

const contentFiles = [
  'content-script-helpers.js',
  'content-dom-baseline.js',
  'content-element-registry.js',
  'content-dom-query.js',
  'content-input.js',
  'content-patch.js',
];
const contentMethods: Record<string, string> = {
  'input.observe_start': 'beginNativeObservation',
  'input.observe_finish': 'finishNativeObservation',
  'input.resolve_native': 'prepareNativeInput',
  'input.revalidate_native': 'revalidateNativeInput',
  'input.read_value': 'readInputValue',
};

const fixture = `<!doctype html><html><title>Private input regression fixture</title>
<style>body{padding:20px}button,input{font:16px system-ui;padding:12px}</style>
<button id="save">Save synthetic state</button><button id="signal">Signal unload</button>
<input id="text" value="existing"><output id="status" role="status">Ready</output>
<script>
(() => {
  const Observer = MutationObserver;
  let clicks=0, trusted=0, blockClear=false;
  document.querySelector('#save').addEventListener('click', event => {
    clicks++; if(event.isTrusted) trusted++;
    document.querySelector('#status').textContent='Saved '+clicks;
  });
  document.querySelector('#signal').addEventListener('click', () => window.dispatchEvent(new Event('beforeunload')));
  document.querySelector('#text').addEventListener('beforeinput', event => {
    if(blockClear && event.inputType.startsWith('delete')) event.preventDefault();
  });
  window.blockNativeClear = value => { blockClear=value; };
  window.fixtureState = () => ({
    clicks, trusted, value:document.querySelector('#text').value,
    mainObserverUnchanged:MutationObserver===Observer
  });
})();
</script></html>`;

export class InputLiveBrowser {
  private child?: ChildProcess;
  private exit?: Promise<unknown>;
  private connection?: ChromePipe;
  private log = -1;
  readonly hashes: Record<string, string> = {};
  version: Record<string, unknown> = {};

  constructor(readonly root: string) {}

  get pipe(): ChromePipe {
    assert(this.connection);
    return this.connection;
  }

  async start(executable: string): Promise<void> {
    assert(
      path.isAbsolute(executable),
      'BBX_INPUT_CHROME must be an absolute Chrome for Testing/Chromium executable.'
    );
    const profile = path.join(this.root, 'profile');
    const home = path.join(this.root, 'home');
    await mkdir(profile, { recursive: true });
    await mkdir(home, { recursive: true });
    this.log = openSync(path.join(this.root, 'chrome.log'), 'w', 0o600);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith('BBX_') &&
          !key.startsWith('BROWSER_BRIDGE_') &&
          !key.startsWith('OPENCODE_')
      )
    );
    this.child = spawn(
      executable,
      [
        `--user-data-dir=${profile}`,
        '--headless=new',
        '--remote-debugging-pipe',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        'about:blank',
      ],
      {
        env: {
          ...env,
          HOME: home,
          CFFIXED_USER_HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: path.join(home, 'cache'),
        },
        stdio: ['ignore', this.log, this.log, 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      }
    );
    this.child.on('error', (error) => this.connection?.close(error));
    this.exit = once(this.child, 'exit');
    // A spawn error rejects once(exit); keep that rejection handled until teardown.
    void this.exit.catch(() => {});
    this.connection = new ChromePipe(
      this.child.stdio[3] as Writable,
      this.child.stdio[4] as Readable
    );
    this.version = await this.pipe.command('Browser.getVersion', {}, undefined, 15000);
  }

  async page(legacyInput?: string): Promise<InputLivePage> {
    const target = await this.pipe.command('Target.createTarget', { url: 'about:blank' });
    const attached = await this.pipe.command('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    const session = String(attached.sessionId);
    await this.pipe.command('Page.enable', {}, session);
    // Only this disposable browser's own target is activated.
    await this.pipe.command('Page.bringToFront', {}, session);
    const tree = await this.pipe.command('Page.getFrameTree', {}, session);
    const frame = object(object(tree.frameTree).frame);
    await this.pipe.command(
      'Page.setDocumentContent',
      { frameId: frame.id, html: fixture },
      session,
      10000
    );
    const world = await this.pipe.command(
      'Page.createIsolatedWorld',
      {
        frameId: frame.id,
        worldName: 'BBX-disposable-input-regressions',
      },
      session
    );
    const page = new InputLivePage(
      this,
      String(target.targetId),
      session,
      Number(world.executionContextId)
    );
    for (const file of contentFiles) {
      const code =
        file === 'content-input.js' && legacyInput
          ? legacyInput
          : await readFile(extensionFile(`src/${file}`), 'utf8');
      this.hashes[`${legacyInput ? 'legacy' : 'current'}/${file}`] = createHash('sha256')
        .update(code)
        .digest('hex');
      await page.evaluate(code);
    }
    assert.equal(
      await page.evaluate('typeof globalThis.__BBX_CONTENT_INPUT__', false),
      'undefined'
    );
    return page;
  }

  async close(): Promise<void> {
    try {
      if (this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) {
        await this.connection?.command('Browser.close', {}, undefined, 3000).catch(() => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.exit,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Owned Chrome did not exit')), 5000);
            }),
          ]);
        } catch {
          for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
            if (this.child.exitCode !== null || this.child.signalCode !== null) break;
            try {
              if (process.platform === 'win32') this.child.kill(signal);
              else process.kill(-this.child.pid, signal);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
            let signalTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                this.exit,
                new Promise<never>((_resolve, reject) => {
                  signalTimer = setTimeout(
                    () => reject(new Error(`Owned Chrome ignored ${signal}`)),
                    5000
                  );
                }),
              ]);
              break;
            } catch (error) {
              if (signal === 'SIGKILL') throw error;
            } finally {
              clearTimeout(signalTimer);
            }
          }
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      this.connection?.close();
      if (this.log >= 0) closeSync(this.log);
      if (!this.child?.pid || this.child.exitCode !== null || this.child.signalCode !== null) {
        await rm(path.join(this.root, 'profile'), { recursive: true, force: true });
        await rm(path.join(this.root, 'home'), { recursive: true, force: true });
      }
    }
  }
}

export class InputLivePage {
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly responses: Array<{ method: string; response: Record<string, unknown> }> = [];
  expireObservation = false;
  private extras: string[] = [];
  private readonly controller: ReturnType<typeof createBackgroundInputController>;

  constructor(
    private readonly browser: InputLiveBrowser,
    readonly target: string,
    readonly session: string,
    readonly world: number
  ) {
    this.controller = createBackgroundInputController({
      getTab: async () => ({
        active: (await this.evaluate('document.visibilityState === "visible"', false)) === true,
      }),
      runWithDebugger: async (_tab, operation) => operation({ tabId: 1 }),
      sendCommand: async (_target, method, params) => {
        this.commands.push({ method, params });
        return this.browser.pipe.command(method, params, this.session);
      },
      sendTabMessage: async (_tab, message) => {
        const method = String(message.method);
        const implementation = contentMethods[method];
        assert(implementation);
        const params = object(message.params ?? {});
        if (method === 'input.observe_finish' && params.discard !== true) {
          await this.evaluate('globalThis.__bbxLiveFault?.armFinish()');
          if (this.expireObservation) {
            this.expireObservation = false;
            this.extras = (await this.evaluate(
              `Array.from({length:8}, () => globalThis.__BBX_CONTENT_INPUT__.beginNativeObservation().observationId)`
            )) as string[];
          }
        }
        const response = object(
          await this.evaluate(`(async () => {
          try { return await globalThis.__BBX_CONTENT_INPUT__[${JSON.stringify(implementation)}](${JSON.stringify(params)}); }
          catch(error) { return {error: typeof error?.code === 'string'
            ? {code:error.code,message:error.message,details:error.details ?? null}
            : String(error?.message ?? error)}; }
        })()`)
        );
        this.responses.push({ method, response });
        return response;
      },
      contentScriptTimeoutMs: 5000,
    });
  }

  async evaluate(expression: string, isolated = true): Promise<unknown> {
    const result = await this.browser.pipe.command(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...(isolated ? { contextId: this.world } : {}),
      },
      this.session,
      10000
    );
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return object(result.result).value;
  }

  async state(): Promise<Record<string, unknown>> {
    return object(await this.evaluate('window.fixtureState()', false));
  }

  async native(
    method: BridgeMethod = 'input.click',
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const request = createRequest({
      id: crypto.randomUUID(),
      method,
      params: { target: { selector: '#save' }, observe: { settleMs: 50 }, timeoutMs: 0, ...params },
    });
    return this.controller.handleNativeInput(
      request,
      {
        tabId: 1,
        windowId: 1,
        url: 'about:blank',
        title: 'Own disposable fixture',
      },
      request.params
    );
  }

  async dom(): Promise<Record<string, unknown>> {
    return object(
      await this.evaluate(`globalThis.__BBX_CONTENT_INPUT__.clickTarget({
      target:{selector:'#save'},observe:{settleMs:50},timeoutMs:0
    })`)
    );
  }

  async fault(kind: 'constructor' | 'observe' | 'finish'): Promise<void> {
    await this.evaluate(`(() => {
      const descriptor=Object.getOwnPropertyDescriptor(globalThis,'MutationObserver');
      const title=Object.getOwnPropertyDescriptor(document,'title');
      const Native=MutationObserver;
      const metrics={kind:${JSON.stringify(kind)},constructors:0,observeCalls:0,disconnectCalls:0,throws:0};
      const fail=() => {metrics.throws++;throw new Error('BBX_TEST_ONLY_OBSERVER_THROW');};
      const ProxyObserver=new Proxy(Native,{construct(target,args) {
        metrics.constructors++;
        if(metrics.kind==='constructor') fail();
        const observer=Reflect.construct(target,args);
        Object.defineProperty(observer,'observe',{value(...args) {
          metrics.observeCalls++;
          if(metrics.kind==='observe') fail();
          return Native.prototype.observe.apply(observer,args);
        }});
        Object.defineProperty(observer,'disconnect',{value() {
          metrics.disconnectCalls++;
          return Native.prototype.disconnect.call(observer);
        }});
        return observer;
      }});
      Object.defineProperty(globalThis,'MutationObserver',{configurable:true,writable:true,value:ProxyObserver});
      globalThis.__bbxLiveFault={
        armFinish() {
          if(metrics.kind==='finish') Object.defineProperty(document,'title',{configurable:true,get:fail});
        },
        restore() {
          if(descriptor) Object.defineProperty(globalThis,'MutationObserver',descriptor);
          else delete globalThis.MutationObserver;
          if(title) Object.defineProperty(document,'title',title); else delete document.title;
          return {...metrics,restored:globalThis.MutationObserver===Native};
        }
      };
    })()`);
  }

  async restore(): Promise<Record<string, unknown> | null> {
    return (await this.evaluate(`(() => {
      const fault=globalThis.__bbxLiveFault;
      if(!fault) return null;
      try{return fault.restore();}finally{delete globalThis.__bbxLiveFault;}
    })()`)) as Record<string, unknown> | null;
  }

  async close(): Promise<void> {
    try {
      await this.restore();
      for (const observationId of this.extras) {
        await this.evaluate(
          `globalThis.__BBX_CONTENT_INPUT__.finishNativeObservation(${JSON.stringify({ observationId, discard: true })})`
        );
      }
    } finally {
      await this.browser.pipe.command('Target.closeTarget', { targetId: this.target });
    }
  }
}
