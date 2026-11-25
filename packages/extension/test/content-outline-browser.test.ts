import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chromeSkipReason,
  runContentCheckInChrome,
} from '../../../tests/_helpers/contentBrowser.ts';

/** Exercise actual CSSOM changes, not a simulated computed-style function. */
async function checkCssomOutline(): Promise<void> {
  const query = Reflect.get(globalThis, '__BBX_CONTENT_DOM_QUERY__') as {
    getAccessibilityOutline: (
      params: Record<string, unknown>
    ) => import('../../../protocol/src/types.js').DomOutlineResult;
  };
  const root = document.createElement('section');
  root.id = 'outline-cssom-fixture';
  root.setAttribute('aria-label', 'Outline CSSOM fixture');
  root.innerHTML = [
    '<style>#outline-cssom-fixture .dynamic { display: none; }</style>',
    '<button>First</button><button>Second</button><button>Third</button>',
    '<button class="dynamic">Dynamic</button>',
  ].join('');
  document.body.append(root);
  const params = { selector: '#outline-cssom-fixture', maxNodes: 50 };
  const base = query.getAccessibilityOutline({ ...params, snapshotId: 'cssom-base' });
  if (base.outline?.includes('"Dynamic"')) throw new Error('Hidden button entered the base.');
  const sheet = root.querySelector('style')?.sheet;
  if (!sheet) throw new Error('Fixture stylesheet missing.');
  sheet.insertRule('#outline-cssom-fixture .dynamic { display: inline-block; }', 1);
  const shown = query.getAccessibilityOutline({
    ...params,
    since: 'cssom-base',
    snapshotId: 'cssom-shown',
  });
  const added = shown.delta?.added as string[] | undefined;
  if (
    shown.unchanged ||
    shown.count !== base.count + 1 ||
    !added?.some((line) => line.includes('"Dynamic"'))
  )
    throw new Error(`CSSOM visibility change missed: ${JSON.stringify(shown)}`);
  sheet.deleteRule(1);
  const hidden = query.getAccessibilityOutline({
    ...params,
    since: 'cssom-shown',
    snapshotId: 'cssom-hidden',
  });
  if (hidden.unchanged || hidden.count !== base.count || hidden.delta?.removed.length !== 1)
    throw new Error(`CSSOM hiding change missed: ${JSON.stringify(hidden)}`);
}

test(
  'outline snapshots see CSSOM visibility changes in Chrome',
  { skip: chromeSkipReason },
  async () => {
    const { passed, output } = await runContentCheckInChrome(checkCssomOutline);
    assert.equal(passed, true, output);
  }
);
