import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDriver } from './bbx-driver.ts';
import { comparePairs, pairedOrder, runEpisode, summarize } from './runner.ts';
import { selectTasks } from './tasks.ts';
import type { Driver, EpisodeResult } from './types.ts';
import { repoRoot } from '../../_helpers/runCli.ts';
import { validateDriver } from './validation.ts';

export function parseArgs(args: readonly string[]) {
  const options = {
    runs: 1,
    seed: 1,
    headed: false,
    chrome: process.env.BBX_BENCH_CHROME ?? '',
    drivers: [] as string[],
    tasks: [] as string[],
  };
  for (const arg of args) {
    if (arg === '--headed') options.headed = true;
    else if (arg.startsWith('--runs=')) options.runs = Number(arg.slice(7));
    else if (arg.startsWith('--seed=')) options.seed = Number(arg.slice(7));
    else if (arg.startsWith('--chrome=')) options.chrome = arg.slice(9);
    else if (arg.startsWith('--driver=')) options.drivers.push(arg.slice(9));
    else if (arg.startsWith('--tasks=')) options.tasks = arg.slice(8).split(',');
    else throw new Error(`Unknown benchmark option: ${arg}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 1000)
    throw new Error('--runs must be 1..1000');
  if (
    !Number.isSafeInteger(options.seed) ||
    options.seed < 0 ||
    options.seed + options.runs > 0xffffffff
  )
    throw new Error('Invalid seed range');
  if (!path.isAbsolute(options.chrome))
    throw new Error('Set BBX_BENCH_CHROME or --chrome to an absolute Chrome executable');
  for (const module of options.drivers)
    if (!path.isAbsolute(module)) throw new Error('--driver must be an absolute module path');
  selectTasks(options.tasks);
  return options;
}

export async function main(args: readonly string[]) {
  const options = parseArgs(args);
  const drivers: Driver[] = [validateDriver(await createDriver(options))];
  const hash = async (file: URL | string) =>
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  const modules: Record<string, string> = {
    'bbx-mcp': await hash(new URL('./bbx-driver.ts', import.meta.url)),
  };
  for (const filename of options.drivers) {
    // Explicit user-supplied trusted adapters only. Never download a comparator.
    const loaded: unknown = await import(pathToFileURL(filename).href);
    const factory =
      loaded && typeof loaded === 'object'
        ? (loaded as Record<string, unknown>).createDriver
        : null;
    if (typeof factory !== 'function')
      throw new Error('Driver module must export createDriver(options)');
    const driver = validateDriver(await factory(options));
    drivers.push(driver);
    modules[driver.identity.name] = await hash(filename);
  }
  if (new Set(drivers.map((driver) => driver.identity.name)).size !== drivers.length)
    throw new Error('Driver names must be unique configuration IDs');
  const selected = selectTasks(options.tasks);
  const fixtureSHA256 = createHash('sha256')
    .update(await readFile(new URL('./app.ts', import.meta.url)))
    .update(await readFile(new URL('./fixture.ts', import.meta.url)))
    .update(await readFile(new URL('./tasks.ts', import.meta.url)))
    .digest('hex');
  const directory = path.join(repoRoot, 'dist/comparative-benchmark');
  await mkdir(directory, { recursive: true });
  const output = await mkdtemp(path.join(directory, 'run-'));
  const results: EpisodeResult[] = [];
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    episodes: for (let run = 0; run < options.runs; run++) {
      const seed = options.seed + run;
      for (const task of pairedOrder(selected, seed)) {
        for (const driver of pairedOrder(drivers, seed)) {
          if (abort.signal.aborted) break episodes;
          const result = await runEpisode(
            driver,
            task,
            seed,
            path.join(output, `${seed}-${task.id}-${driver.identity.name}`),
            abort.signal
          );
          results.push(result);
          // Save after every episode, including unsupported/invalid cells.
          await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
        }
      }
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
  const report = {
    schemaVersion: 1,
    trackWarning:
      'Scripted reliability and agent efficiency are separate tracks. No aggregate winner score.',
    sampleWarning:
      options.runs < 30
        ? 'Pilot sample only. Tail latency and comparative claims are not established.'
        : options.runs < 200
          ? 'Tail latency is exploratory at this sample size. Use paired per-task results, not pooled superiority claims.'
          : null,
    options,
    modules,
    fixtureSHA256,
    interrupted: abort.signal.aborted,
    plannedCells: options.runs * selected.length * drivers.length,
    notRun: options.runs * selected.length * drivers.length - results.length,
    summaries: summarize(results),
    comparisons: comparePairs(results),
    perTask: selected.map((task) => {
      const rows = results.filter((result) => result.task === task.id);
      return { task: task.id, summaries: summarize(rows), comparisons: comparePairs(rows) };
    }),
  };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { output, sampleWarning: report.sampleWarning, summaries: report.summaries },
      null,
      2
    )
  );
  // Safe refusals/unsupported cells remain explicit, but cannot green a smoke run.
  if (results.some((result) => result.status !== 'unsupported' && !result.assessment?.success))
    process.exitCode = 1;
  if (abort.signal.aborted) process.exitCode = 130;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Reports are already saved to disk. A supervisor or `head` may close stdout
  // while cleanup/reporting completes; do not crash and mask the real exit code.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') {
      console.error(error);
      process.exitCode = 1;
    }
  });
  await main(process.argv.slice(2));
}
