import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chromeSkipReason,
  runContentCheckInChrome,
} from '../../../tests/_helpers/contentBrowser.ts';

// Large-page fixtures: reads and input stay correct and bounded on 5k, 20k and
// 50k-element pages, under constant mutation, and across deep shadow trees.
async function checkLargePages(): Promise<void> {
  type Fn = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  const input = Reflect.get(globalThis, '__BBX_CONTENT_INPUT__') as Record<string, Fn>;
  const listener = Reflect.get(globalThis, '__bbxListener') as (
    message: { type: string; method: string; params: Record<string, unknown> },
    sender: object,
    respond: (value: Record<string, unknown>) => void
  ) => void;
  const call = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) =>
      listener({ type: 'bridge.execute', method, params }, {}, resolve)
    );
  const failures: string[] = [];
  const timed = async (label: string, budgetMs: number, run: () => Promise<void>) => {
    const started = performance.now();
    try {
      await run();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const elapsed = performance.now() - started;
    if (elapsed > budgetMs)
      failures.push(`${label}: took ${Math.round(elapsed)} ms (budget ${budgetMs})`);
  };
  const fill = (count: number) => {
    const rows: string[] = [];
    for (let index = 0; index < count; index += 1)
      rows.push(`<div class="row"><span>Row ${index}</span></div>`);
    document.body.innerHTML = `<main>${rows.join('')}<button id="end">Finish</button></main>`;
  };

  for (const size of [5_000, 20_000, 50_000]) {
    fill(size / 2);
    await timed(`${size}: page.get_text`, 3000, async () => {
      const text = await call('page.get_text', { textBudget: 2000 });
      if (text.truncated !== true) throw new Error('expected truncated text');
    });
    await timed(`${size}: click by role at the end`, 3000, async () => {
      let clicked = 0;
      document.getElementById('end')?.addEventListener('click', () => (clicked += 1));
      await input.clickTarget({ target: { role: 'button', name: 'Finish' } });
      if (clicked !== 1) throw new Error('button not clicked');
    });
    await timed(`${size}: outline scope finds a late modal`, 3000, async () => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div role="dialog" aria-modal="true"><button>Confirm</button></div>'
      );
      const outline = await call('dom.get_accessibility_tree', {
        scope: 'auto',
        find: 'Confirm',
        context: 0,
      });
      const scope = outline.scope as { resolved?: string } | undefined;
      if (scope?.resolved !== 'modal') throw new Error(`scope ${JSON.stringify(scope)}`);
    });
  }

  // Constant mutation: a target that appears later is still found within the
  // auto-wait, while a timer rewrites the page every few milliseconds.
  fill(5_000);
  const churn = setInterval(() => {
    const row = document.querySelector('.row span');
    if (row) row.textContent = String(Math.random());
  }, 5);
  setTimeout(() => {
    document.body.insertAdjacentHTML('beforeend', '<button id="late">Late</button>');
  }, 300);
  await timed('mutating page: auto-wait for a late button', 6000, async () => {
    let clicked = 0;
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const poll = setInterval(() => {
        const button = document.getElementById('late');
        if (button && !button.dataset.wired) {
          button.dataset.wired = '1';
          button.addEventListener('click', () => (clicked += 1));
        }
      }, 1);
      input.clickTarget({ target: { role: 'button', name: 'Late' }, timeoutMs: 5000 }).then(
        (value) => {
          clearInterval(poll);
          resolve(value);
        },
        (error) => {
          clearInterval(poll);
          reject(error);
        }
      );
    });
    if (!result.clicked || clicked !== 1) throw new Error('late button not clicked');
  });
  clearInterval(churn);

  // Deep shadow trees: a field forty roots down is reachable and typeable.
  document.body.innerHTML = '<div id="root"></div>';
  let host = document.getElementById('root') as HTMLElement;
  for (let depth = 0; depth < 40; depth += 1) {
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      depth === 39 ? '<input id="deep" aria-label="Deep field">' : '<div class="level"></div>';
    host = (shadow.querySelector('.level') as HTMLElement) ?? host;
  }
  await timed('deep shadow: fill by label', 3000, async () => {
    const result = await input.fillTarget({ target: { label: 'Deep field' }, value: 'found' });
    if (result.value !== 'found') throw new Error(`value ${String(result.value)}`);
  });

  if (failures.length) throw new Error(`FAILURES\n${failures.join('\n')}`);
}

test(
  'large, mutating, and deeply shadowed pages stay correct and bounded in Chrome',
  { skip: chromeSkipReason, timeout: 120_000 },
  async () => {
    const result = await runContentCheckInChrome(checkLargePages, { virtualTimeBudgetMs: 60_000 });
    assert.ok(result.passed, result.output.replace(/<[^>]+>/g, '').slice(0, 4000));
  }
);
