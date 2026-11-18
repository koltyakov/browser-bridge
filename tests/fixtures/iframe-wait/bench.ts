import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ChaosHarness } from '../../live/chaos-harness.ts';
import { repoRoot } from '../../_helpers/runCli.ts';
import { pairedOrder } from '../comparative-benchmark/runner.ts';
import { explain, measure, summarize, type Sample, type Workload } from './timing.ts';
import { traceWorker } from './trace.ts';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '30' },
    seed: { type: 'string', default: '100' },
    'target-ms': { type: 'string', default: '500' },
    'baseline-extension': { type: 'string' },
    chrome: { type: 'string', default: process.env.BBX_BENCH_CHROME },
  },
});
const runs = Number(values.runs),
  first = Number(values.seed),
  targetMs = Number(values['target-ms']);
const chrome = values.chrome ?? '';
assert(path.isAbsolute(chrome), 'Set BBX_BENCH_CHROME to an absolute executable');
assert(
  Number.isInteger(runs) &&
    runs >= 1 &&
    runs <= 1000 &&
    Number.isSafeInteger(first) &&
    first >= 0 &&
    first + runs <= 0xffffffff,
  'Invalid run count or seed'
);
assert(Number.isFinite(targetMs) && targetMs > 0, 'Expected a positive --target-ms');
const builds: Record<string, string> = { current: path.join(repoRoot, 'dist/ext') };
if (values['baseline-extension']) builds.baseline = path.resolve(values['baseline-extension']);
const directory = path.join(repoRoot, 'dist', 'iframe-wait');
await mkdir(directory, { recursive: true });
const output = await mkdtemp(path.join(directory, 'run-'));
const clockNow = () => performance.timeOrigin + performance.now();
const stamp = 'performance.timeOrigin+performance.now()';
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (req.url === '/frames')
    res.end(
      Array.from({ length: 11 }, (_, i) => `<iframe id="f${i}" src="/child"></iframe>`).join('')
    );
  else if (req.url === '/late' || req.url === '/navigated') {
    // The marker is visible when appended. Mark it in the same JS task so
    // BBX cannot observe it before the readiness timestamp is recorded.
    res.end(
      `<body><script>const p=document.createElement('p');p.id='${req.url.slice(1)}';p.textContent='ready';document.body.append(p);p.dataset.readyAt=String(${stamp})</script>`
    );
  } else res.end('<p>child</p>');
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address === 'object');
const page = `http://127.0.0.1:${address.port}/frames`;
const cases: Workload[] = ['existing', 'missing', 'attach', 'navigate'];
const samples: Sample[] = [];
const traces: Record<string, unknown>[] = [];
const saveLine = (file: string, data: unknown) =>
  appendFile(path.join(output, file), JSON.stringify(data) + '\n');

async function episode(build: string, seed: number, replay?: Workload) {
  const h = new ChaosHarness({
    portable: true,
    headless: true,
    extensionDirectory: builds[build],
    outputDirectory: path.join(output, `${build}-${seed}-${replay ?? 'normal'}`),
  });
  try {
    await h.start(chrome);
    const client = h.control;
    assert(client);
    const inject = (body: string) =>
      h.uiEvaluate(
        `(await chrome.scripting.executeScript({target:{tabId:${h.tabId}},func:()=>{${body}}}))[0].result`
      );
    await h.call(client, 'navigation.navigate', { url: page, waitForLoad: true });
    await h.call(client, 'dom.find_by_role', { role: 'button', maxResults: 1 });
    const frames = await h.uiEvaluate(
      `chrome.scripting.executeScript({target:{tabId:${h.tabId},allFrames:true},func:()=>document.readyState})`
    );
    assert(Array.isArray(frames) && frames.length === 12, 'Expected 12 fixture documents');
    // Bracket browser epoch time with host reads. Prefer the narrowest
    // round trip; neither clock synchronization nor zero RPC latency is assumed.
    let clock = { offsetMs: 0, uncertaintyMs: Infinity };
    for (let i = 0; i < 5; i++) {
      const t = clockNow(),
        browser = await inject(`return ${stamp}`),
        end = clockNow();
      assert(typeof browser === 'number' && Number.isFinite(browser));
      const uncertaintyMs = (end - t) / 2 + 0.1; // browser timestamp precision
      if (uncertaintyMs < clock.uncertaintyMs)
        clock = { offsetMs: (end + t) / 2 - browser, uncertaintyMs };
    }
    const order: Workload[] = [
      ...pairedOrder<Workload>(['existing', 'missing'], seed),
      'attach',
      'navigate',
    ];
    for (const workload of order) {
      // Keep the same warm-up/workload order for a replay. Only attach the
      // debugger for the selected wait, and never pool its sample with normal runs.
      const readTrace = replay === workload ? await traceWorker(h) : undefined;
      const delay = 150 + (seed % 5) * 10;
      const selector = {
        existing: '#appeared',
        missing: '#missing',
        attach: '#late',
        navigate: '#navigated',
      }[workload];
      const frame = { existing: '#f10', missing: '', attach: '#new', navigate: '#f9' }[workload];
      if (workload === 'attach') await inject("document.querySelector('#f10').remove()");
      const mutation = {
        existing: `const d=document.querySelector('#f10').contentDocument;const p=d.createElement('p');p.id='appeared';p.textContent='ready';d.body.append(p);p.dataset.readyAt=String(${stamp})`,
        missing: '',
        attach:
          "const f=document.createElement('iframe');f.id='new';f.src='/late';document.body.append(f)",
        navigate: "document.querySelector('#f9').src='/navigated'",
      }[workload];
      if (mutation) await inject(`setTimeout(()=>{${mutation}},${delay})`);
      const startedAt = clockNow();
      const result = await h.call(client, 'dom.wait_for', {
        selector,
        state: 'visible',
        timeoutMs: workload === 'missing' ? 1000 : 2000,
      });
      const returnedAt = clockNow(); // before evidence/trace reads and file I/O
      assert.equal(result.found, workload !== 'missing');
      let browserReadyAt: number | null = null,
        frameId: number | null = null;
      if (result.found) {
        assert(typeof result.frameId === 'number' && result.frameId > 0);
        frameId = result.frameId;
        const mark = await inject(
          `return Number(document.querySelector('${frame}').contentDocument.querySelector('${selector}').dataset.readyAt)`
        );
        assert(typeof mark === 'number');
        browserReadyAt = mark;
      }
      const sample: Sample = {
        build,
        seed,
        workload,
        startedAt,
        returnedAt,
        browserReadyAt,
        frameId,
        clock,
        ...measure(startedAt, returnedAt, browserReadyAt, clock),
      };
      if (readTrace) {
        const stages = await readTrace();
        const trace = { sample, stages, discovery: explain(stages, sample) };
        traces.push({
          seed,
          workload,
          readyToMatchMs: sample.readyToMatchMs,
          discovery: trace.discovery,
        });
        await saveLine('traces.jsonl', trace);
        break;
      }
      if (!replay) {
        samples.push(sample);
        await saveLine('samples.jsonl', sample);
      }
    }
  } finally {
    await h.close();
  }
}
try {
  console.log(`Iframe wait benchmark: ${output}`);
  for (let seed = first; seed < first + runs; seed++)
    for (const build of pairedOrder(Object.keys(builds), seed)) await episode(build, seed);
  const summaries = Object.keys(builds).flatMap((build) =>
    cases.map((workload) => ({
      build,
      workload,
      ...summarize(
        samples.filter((s) => s.build === build && s.workload === workload),
        targetMs
      ),
    }))
  );
  const report = { runs, first, targetMs, builds, summaries, traces };
  const save = () =>
    writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await save();
  for (const row of summaries.filter((r) => r.build === 'current'))
    for (const seed of row.traceSeeds) {
      await episode('current', seed, row.workload);
      await save();
    }
  console.log(JSON.stringify({ output, summaries, traces }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
