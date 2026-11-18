import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChaosHarness } from '../../live/chaos-harness.ts';
import type { Stage } from './timing.ts';

/** Non-pausing logpoints on a diagnostic replay of the unchanged dev build.
 * Resolve against the JS actually loaded by this private worker. If the emit
 * changes, fail rather than silently interpreting missing probes as no hints. */
export async function traceWorker(h: ChaosHarness) {
  const targets = (await h.cdp.command('Target.getTargets')).targetInfos as {
    type: string;
    url: string;
    targetId: string;
  }[];
  const worker = targets.find(
    (t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js')
  );
  assert(worker, 'Private extension worker missing');
  const { sessionId } = await h.cdp.command('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  });
  assert(typeof sessionId === 'string');
  const command = (m: string, p: Record<string, unknown> = {}) =>
    h.cdp.command(m, p, sessionId, 5000);
  const evaluate = async (expression: string) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return (result.result as { value: unknown }).value;
  };
  try {
    await command('Debugger.enable');
    await evaluate('globalThis.__bbxWaitTrace=[]');
    const files = new Map<string, string[]>();
    async function probe(file: string, needle: string, stage: string, fields = '', occurrence = 0) {
      let lines = files.get(file);
      if (!lines) {
        lines = (await readFile(path.join(h.root, 'extension', 'src', `${file}.js`), 'utf8')).split(
          '\n'
        );
        files.set(file, lines);
      }
      const matches = lines.flatMap((line, i) => (line.trim() === needle ? [i] : []));
      assert(
        matches.length && (occurrence > 0 || matches.length === 1),
        `Cannot identify ${stage} in ${file}`
      );
      const lineNumber = matches[occurrence > 0 ? occurrence - 1 : 0];
      assert(lineNumber !== undefined);
      const bp = await command('Debugger.setBreakpointByUrl', {
        url: new URL(`${file}.js`, worker!.url).href,
        lineNumber,
        condition: `(globalThis.__bbxWaitTrace.push({stage:${JSON.stringify(stage)},at:performance.timeOrigin+performance.now()${fields}}),false)`,
      });
      assert(
        Array.isArray(bp.locations) && bp.locations.some((l) => l.lineNumber === lineNumber),
        `Unbound ${stage} logpoint`
      );
    }
    const wait = 'background-frame-wait',
      content = 'background-content-script';
    await probe('background-runtime', 'options.onFrameTreeChanged?.(sender.tab.id);', 'hint');
    await probe(wait, 'refresh = setTimeout(() => void discover(), 0);', 'arm-initial');
    const wake = 'refresh = setTimeout(() => void discover(), 16);';
    await probe(wait, wake, 'arm-event', '', 1);
    await probe(wait, wake, 'arm-event', '', 2);
    await probe(
      wait,
      'refresh = setTimeout(() => void discover(), Math.min(500, Math.ceil(untilFinalCheck)));',
      'arm-fallback'
    );
    await probe(wait, 'discovering = true;', 'discover');
    await probe(content, 'frames = await read();', 'injection-settled', ',frameIds', 2);
    await probe(
      wait,
      'watchFrame(0, current.find((frame) => frame.frameId === 0)?.tag);',
      'enumerated',
      ',frameIds:current.filter(f=>f.tag!==null).map(f=>f.frameId)'
    );
    await probe(
      wait,
      'const remaining = Math.max(1, Math.ceil(deadline - performance.now()));',
      'watch',
      ',frameId'
    );
    await probe(wait, 'watches.delete(frameId);', 'match', ',frameId', 1);
    return async () => (await evaluate('globalThis.__bbxWaitTrace')) as Stage[];
  } catch (error) {
    await command('Debugger.disable');
    throw error;
  }
  // The entire private browser and debugger session close with this replay.
}
