import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main, parseArgs } from './cli.ts';
import { comparePairs, pairedOrder, runEpisode, summarize } from './runner.ts';
import { selectTasks } from './tasks.ts';
import type { Driver, DriverSession, EpisodeContext } from './types.ts';
import { AdapterValidationError, validateDriver } from './validation.ts';

/** In-process controller self-test. Never labeled as a browser comparison. */
function controllerTestDriver(changes: Partial<Driver> = {}): Driver {
  return {
    identity: { name: 'controller-self-test', version: 'test', track: 'scripted' },
    supportedTasks: ['save'],
    browserRequestsObservable: false,
    async open(context) {
      return {
        provenance: { syntheticControllerTest: true },
        async run() {
          const response = await fetch(new URL('/effect', context.url), {
            method: 'POST',
            body: JSON.stringify({ operation: 'save', record: 'main', value: 'ada@example.test' }),
          });
          context.measure({ kind: 'tool', responseBytes: (await response.text()).length });
          return { reported: 'completed' };
        },
        async observe() {
          return { url: context.url, focusThefts: 0, dialogOpened: 0, dialogClosed: 0 };
        },
        async close() {},
      };
    },
    ...changes,
  };
}
const fastTask = { ...selectTasks(['save'])[0], settleMs: 0 };
async function temporary(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bbx-benchmark-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('paired order is deterministic, seed-sensitive, and does not mutate inputs', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(pairedOrder(items, 11), pairedOrder(items, 11));
  assert.notDeepEqual(pairedOrder(items, 11), pairedOrder(items, 12));
  assert.deepEqual(items, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(pairedOrder([], 1), []);
});

test('CLI rejects unknown options, bad ranges, non-absolute executables/modules and unknown tasks', () => {
  const valid = ['--chrome=/fixture/chrome'];
  assert.equal(
    parseArgs([
      ...valid,
      '--runs=30',
      '--seed=8',
      '--headed',
      '--tasks=spa,save',
      '--driver=/fixture/driver.ts',
    ]).headed,
    true
  );
  for (const args of [
    ['--chrome=relative'],
    [...valid, '--runs=0'],
    [...valid, '--runs=1.5'],
    [...valid, '--seed=-1'],
    [...valid, '--seed=4294967295'],
    [...valid, '--driver=relative'],
    [...valid, '--tasks=missing'],
    [...valid, '--guess'],
  ])
    assert.throws(() => parseArgs(args));
});

test('runner records independent results, bytes, unavailable tokens, and immutable output files', async (t) => {
  const root = await temporary(t);
  const result = await runEpisode(controllerTestDriver(), fastTask, 1, root);
  assert.equal(result.status, 'measured');
  assert.equal(result.assessment?.success, true);
  assert.equal(result.counts?.tokens, null);
  assert.equal(result.counts?.browserRequests, null);
  assert.equal(result.counts?.hostToolCalls, 1);
  assert(result.observation!.goalAtMs! >= 0);
  assert.equal(result.cleanup, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8')), result);
  await assert.rejects(runEpisode(controllerTestDriver(), fastTask, 1, root), /EEXIST/);
  const unsupported = await runEpisode(
    controllerTestDriver(),
    selectTasks(['background'])[0],
    1,
    path.join(root, 'unsupported')
  );
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.counts, null);
  const report = summarize([result, unsupported])[0];
  assert.equal(report.completionRate, 0.5);
  assert.equal(report.unsupported, 1);
  assert.equal(report.tokens, null);
});

test('a task timeout is a measured failure, not a cheap success or abandoned session', async (t) => {
  let closed = false;
  const driver = controllerTestDriver({
    async open(context) {
      return {
        provenance: {},
        run: () =>
          new Promise((_resolve, reject) =>
            context.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            })
          ),
        async observe() {
          return { url: context.url, focusThefts: 0, dialogOpened: 0, dialogClosed: 0 };
        },
        async close() {
          closed = true;
        },
      };
    },
  });
  const result = await runEpisode(driver, { ...fastTask, timeoutMs: 10 }, 1, await temporary(t));
  assert.equal(result.timedOut, true);
  assert.equal(result.assessment?.success, false);
  assert.equal(result.cleanup, true);
  assert.equal(closed, true);
  assert.equal(summarize([result])[0].timeouts, 1);
});

test('observation or cleanup failure cannot hide a duplicate committed action', async (t) => {
  const driver = controllerTestDriver({
    async open(context) {
      const session = await controllerTestDriver().open(context);
      return {
        ...session,
        async run() {
          await session.run();
          await session.run();
          return { reported: 'completed' };
        },
        async observe() {
          throw new Error('observer failed');
        },
        async close() {
          throw new Error('cleanup failed');
        },
      };
    },
  });
  const result = await runEpisode(driver, fastTask, 1, await temporary(t));
  assert.equal(result.status, 'invalid');
  assert.equal(result.assessment?.duplicateCommits, 1);
  assert.equal(result.cleanup, false);
  assert.equal(result.counts?.hostToolCalls, 2);
  assert.equal(summarize([result])[0].safetyViolations, 1);
});

test('agent runs require model accounting and retain actual final text', async (t) => {
  const base = controllerTestDriver();
  const identity = {
    name: 'agent-self-test',
    version: 'test',
    track: 'agent' as const,
    model: 'test-model',
    instructionsHash: 'a'.repeat(64),
  };
  const noAccounting = await runEpisode({ ...base, identity }, fastTask, 1, await temporary(t));
  assert.equal(noAccounting.status, 'invalid');
  const root = await temporary(t);
  const agent: Driver = {
    ...base,
    identity,
    async open(context) {
      const session = await base.open(context);
      return {
        ...session,
        async run() {
          context.measure({ kind: 'model', usage: { input: 123, output: 45 } });
          await session.run();
          return { reported: 'completed', finalText: 'Saved the profile once.' };
        },
      };
    },
  };
  const recorded = await runEpisode(agent, fastTask, 1, root);
  assert.equal(recorded.assessment?.success, true);
  assert.equal(await readFile(path.join(root, 'final.txt'), 'utf8'), 'Saved the profile once.');
  assert.equal(summarize([recorded])[0].tokens, 168);
  const incomplete = {
    ...agent,
    async open(context: EpisodeContext) {
      const session = await agent.open(context);
      return {
        ...session,
        async run() {
          context.measure({ kind: 'model', usage: null });
          return session.run();
        },
      };
    },
  };
  const unknown = await runEpisode(incomplete, fastTask, 2, await temporary(t));
  assert.equal(unknown.counts?.tokens, null);
});

test('pair reports do not mix tracks, drop unsupported denominators, or compare failure latency as success', async (t) => {
  const root = await temporary(t);
  const first = await runEpisode(controllerTestDriver(), fastTask, 1, path.join(root, 'first'));
  const second = {
    ...first,
    driver: { ...first.driver, name: 'other' },
    latencyMs: first.latencyMs! + 10,
  };
  const comparisons = comparePairs([first, second]);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].bothSuccess, 1);
  assert(Math.abs(Number(comparisons[0].bothSuccessfulMeanLatencyDeltaMs) + 10) < 0.0001);
  assert.equal(
    comparePairs([first, { ...second, driver: { ...second.driver, track: 'agent' } }]).length,
    0
  );
  const failed = { ...second, assessment: { ...second.assessment!, success: false } };
  assert.equal(comparePairs([first, failed])[0].leftOnlySuccess, 1);
  assert.equal(comparePairs([first, failed])[0].bothSuccessfulMeanLatencyDeltaMs, null);
  assert.equal(comparePairs([first, { ...second, status: 'unsupported' }])[0].unsupportedPairs, 1);
  assert.equal(comparePairs([first, { ...second, status: 'invalid' }])[0].invalidPairs, 1);
  assert.equal(summarize([]).length, 0);
});

test('external adapter modules require a factory, pinned identity, and unique configuration name', async (t) => {
  const root = await temporary(t);
  const badExport = path.join(root, 'bad-export.mjs');
  const badDriver = path.join(root, 'bad-driver.mjs');
  const duplicate = path.join(root, 'duplicate.mjs');
  await writeFile(badExport, 'export const unused = true;');
  await writeFile(badDriver, 'export function createDriver(){return {};}');
  await writeFile(
    duplicate,
    `export function createDriver(){return {
    identity:{name:'bbx-mcp',version:'test',track:'scripted'},supportedTasks:[],
    browserRequestsObservable:false,open:async()=>{throw new Error('must not run');}
  };}`
  );
  await assert.rejects(
    main(['--chrome=/fixture/chrome', `--driver=${badExport}`]),
    /export createDriver/
  );
  await assert.rejects(
    main(['--chrome=/fixture/chrome', `--driver=${badDriver}`]),
    /Invalid adapter identity/
  );
  await assert.rejects(main(['--chrome=/fixture/chrome', `--driver=${duplicate}`]), /unique/);
});

test('controller cancellation cleans up even when a driver does not settle its run promise', async (t) => {
  const abort = new AbortController();
  let closed = false;
  const driver = controllerTestDriver({
    async open(context) {
      return {
        provenance: {},
        run() {
          queueMicrotask(() => abort.abort());
          return new Promise(() => {});
        },
        async observe() {
          return { url: context.url, focusThefts: 0, dialogOpened: 0, dialogClosed: 0 };
        },
        async close() {
          closed = true;
        },
      };
    },
  });
  const result = await runEpisode(driver, fastTask, 1, await temporary(t), abort.signal);
  assert.equal(result.cleanup, true);
  assert.equal(closed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.assessment?.success, false);
});

test('setup rejection and malformed browser evidence cannot certify a successful episode', async (t) => {
  const rejected = await runEpisode(
    controllerTestDriver({
      async open() {
        throw new Error('setup rejected');
      },
    }),
    fastTask,
    1,
    await temporary(t)
  );
  assert.equal(rejected.status, 'invalid');
  assert.equal(rejected.cleanup, false);
  const invalidObservation = await runEpisode(
    controllerTestDriver({
      async open(context) {
        const session = await controllerTestDriver().open(context);
        return {
          ...session,
          async observe() {
            return { url: context.url, focusThefts: NaN, dialogOpened: 0, dialogClosed: 0 };
          },
        };
      },
    }),
    fastTask,
    1,
    await temporary(t)
  );
  assert.equal(invalidObservation.status, 'invalid');
  assert.equal(invalidObservation.assessment?.success, false);
});

test('recovery markers require the declared fault and independent committed goals', async (t) => {
  const faultedTask = { ...fastTask, fault: 'stale_unique' as const };
  const successful = await runEpisode(
    controllerTestDriver({
      async open(context) {
        const session = await controllerTestDriver().open(context);
        return {
          ...session,
          async run() {
            context.markFault();
            const result = await session.run();
            context.markRecovery();
            return result;
          },
        };
      },
    }),
    faultedTask,
    1,
    await temporary(t)
  );
  assert.equal(successful.assessment?.success, true);
  assert.equal(typeof successful.recoveryMs, 'number');
  const premature = await runEpisode(
    controllerTestDriver({
      async open(context) {
        const session = await controllerTestDriver().open(context);
        return {
          ...session,
          async run() {
            context.markFault();
            context.markRecovery();
            return session.run();
          },
        };
      },
    }),
    faultedTask,
    1,
    await temporary(t)
  );
  assert.equal(premature.recoveryMs, null);
  assert.equal(premature.assessment?.success, false);
});

test('canceled setup is joined and its late-created session is closed before returning', async (t) => {
  const abort = new AbortController();
  let closed = false;
  const driver = controllerTestDriver({
    async open(context) {
      queueMicrotask(() => abort.abort());
      await new Promise<void>((resolve) => setImmediate(resolve));
      const session = await controllerTestDriver().open(context);
      return {
        ...session,
        async close() {
          closed = true;
        },
      };
    },
  });
  const result = await runEpisode(driver, fastTask, 1, await temporary(t), abort.signal);
  assert.equal(result.status, 'invalid');
  assert.equal(result.cleanup, true);
  assert.equal(closed, true);
});

test('CLI preserves its exit code when the summary output pipe is closed', async () => {
  // Headless background is unsupported: no browser/model/native daemon is opened.
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./cli.ts', import.meta.url)),
      '--chrome=/fixture/chrome',
      '--tasks=background',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    stderr += text;
  });
  child.stdout.destroy();
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exit, 0, stderr);
  assert.doesNotMatch(stderr, /Unhandled 'error'/);
});

test('malformed dynamically imported descriptors fail before any browser is opened', async (t) => {
  const root = await temporary(t);
  const good = {
    identity: { name: 'external-fixture', version: 'test', track: 'scripted' },
    supportedTasks: ['save'],
    browserRequestsObservable: false,
  };
  const malformed = [
    { ...good, identity: { version: 'test', track: 'scripted' } },
    { ...good, identity: { ...good.identity, name: 123 } },
    { ...good, identity: { ...good.identity, version: 123 } },
    {
      ...good,
      identity: { ...good.identity, track: 'agent', model: [], instructionsHash: 'a'.repeat(64) },
    },
    {
      ...good,
      identity: {
        ...good.identity,
        track: 'agent',
        model: 'test-model',
        instructionsHash: 'not-a-hash',
      },
    },
    { ...good, supportedTasks: ['typo'] },
    { ...good, supportedTasks: ['save', 'save'] },
    { ...good, browserRequestsObservable: 'false' },
  ];
  for (const [index, value] of malformed.entries()) {
    const filename = path.join(root, `invalid-${index}.mjs`);
    await writeFile(
      filename,
      `export function createDriver(){return {
      ...${JSON.stringify(value)},open:async()=>{throw new Error('must not open');}
    };}`
    );
    await assert.rejects(
      main(['--chrome=/fixture/chrome', `--driver=${filename}`]),
      AdapterValidationError
    );
  }
});

test('a dynamic adapter cannot swallow malformed telemetry and report a successful task', async (t) => {
  const root = await temporary(t);
  for (const [index, event] of [
    { kind: 'model', usage: {} },
    { kind: 'unknown-event' },
    { kind: 'tool', responseBytes: '100' },
  ].entries()) {
    const filename = path.join(root, `telemetry-${index}.mjs`);
    // Controller self-test only: this is deliberately not a browser driver.
    await writeFile(
      filename,
      `export function createDriver(){return {
      identity:{name:'malformed-boundary-fixture',version:'test',track:'scripted'},
      supportedTasks:['save'],browserRequestsObservable:true,
      open:async context=>({
        provenance:{syntheticControllerTest:true},
        run:async()=>{
          const response=await fetch(new URL('/effect',context.url),{
            method:'POST',body:JSON.stringify({operation:'save',record:'main',value:'ada@example.test'})
          });
          context.measure({kind:'tool',responseBytes:(await response.text()).length});
          try {context.measure(${JSON.stringify(event)});} catch {}
          return {reported:'completed'};
        },
        observe:async()=>({url:context.url,focusThefts:0,dialogOpened:0,dialogClosed:0}),
        close:async()=>{}
      })
    };}`
    );
    const loaded: unknown = await import(pathToFileURL(filename).href);
    assert(loaded && typeof loaded === 'object');
    const factory = (loaded as Record<string, unknown>).createDriver;
    assert(typeof factory === 'function');
    const driver = validateDriver(await Reflect.apply(factory, undefined, []));
    const result = await runEpisode(driver, fastTask, 1, path.join(root, `episode-${index}`));
    assert.equal(result.status, 'invalid');
    assert.equal(result.assessment?.success, false);
    assert.equal(result.cleanup, true);
    assert.equal(result.observation?.effects.filter((entry) => entry.phase === 'commit').length, 1);
    assert.equal(result.counts?.modelRequests, 0);
    assert.equal(result.counts?.browserRequests, 0);
    assert.equal(result.counts?.hostToolCalls, 1);
    assert.match(result.error ?? '', /Invalid adapter measurement/);
    const recorded = JSON.parse(
      await readFile(path.join(root, `episode-${index}/result.json`), 'utf8')
    );
    assert.equal(recorded.status, 'invalid');
    const measurements = (
      await readFile(path.join(root, `episode-${index}/measurements.jsonl`), 'utf8')
    )
      .trim()
      .split('\n');
    assert.equal(measurements.length, 1, 'Rejected telemetry was appended to the trace');
  }
});

test('malformed sessions still invoke available cleanup once without running actions', async (t) => {
  for (const changes of [
    { run: null },
    { observe: 'not a function' },
    { provenance: null },
    { provenance: { nonfinite: NaN } },
  ]) {
    let closed = 0;
    let ran = false;
    const driver = controllerTestDriver({
      async open(context) {
        const good = await controllerTestDriver().open(context);
        const external: unknown = {
          ...good,
          async run() {
            ran = true;
            return good.run();
          },
          async close() {
            closed++;
          },
          ...changes,
        };
        return external as DriverSession;
      },
    });
    const result = await runEpisode(driver, fastTask, 1, await temporary(t));
    assert.equal(result.status, 'invalid');
    assert.equal(result.assessment?.success, false);
    assert.equal(result.cleanup, true);
    assert.equal(closed, 1);
    assert.equal(ran, false);
  }
});

test('malformed run results invalidate the episode without losing effects or cleanup', async (t) => {
  for (const value of [
    null,
    [],
    { reported: 'success' },
    { reported: 'completed', finalText: 42 },
  ]) {
    let closed = 0;
    const driver = controllerTestDriver({
      async open(context) {
        const good = await controllerTestDriver().open(context);
        return {
          ...good,
          async run() {
            await good.run();
            return value as Awaited<ReturnType<DriverSession['run']>>;
          },
          async close() {
            closed++;
          },
        };
      },
    });
    const result = await runEpisode(driver, fastTask, 1, await temporary(t));
    assert.equal(result.status, 'invalid');
    assert.equal(result.assessment?.success, false);
    assert.equal(result.observation?.effects.length, 2);
    assert.equal(result.cleanup, true);
    assert.equal(closed, 1);
    assert.match(result.error ?? '', /Invalid adapter run result/);
  }
});

test('malformed cleanup acknowledgments cannot certify resource completion', async (t) => {
  const driver = controllerTestDriver({
    async open(context) {
      const good = await controllerTestDriver().open(context);
      return {
        ...good,
        async close() {
          return false;
        },
      } as unknown as DriverSession;
    },
  });
  const result = await runEpisode(driver, fastTask, 1, await temporary(t));
  assert.equal(result.status, 'invalid');
  assert.equal(result.cleanup, false);
  assert.equal(result.assessment?.success, false);
  assert.equal(result.observation?.effects.length, 2);
  assert.match(result.error ?? '', /Invalid adapter session.close/);
  const missing = controllerTestDriver({
    async open(context) {
      return {
        ...(await controllerTestDriver().open(context)),
        close: null,
      } as unknown as DriverSession;
    },
  });
  const noClose = await runEpisode(missing, fastTask, 1, await temporary(t));
  assert.equal(noClose.status, 'invalid');
  assert.equal(noClose.cleanup, false);
  assert.match(noClose.error ?? '', /Invalid adapter session.close/);
});
