import assert from 'node:assert/strict';
import test from 'node:test';
import { withOpenedTabs } from '../src/background-tab-bound.js';

test('input results report tabs the action opened', () => {
  const opened = [{ tabId: 9, url: 'https://popup.test/' }];
  const deps = { tabsOpenedBy: (tabId: number) => (tabId === 4 ? opened : []) };
  const result = withOpenedTabs(
    { clicked: true, effects: { changed: false } },
    'input.click',
    4,
    0,
    deps
  ) as { effects: { newTabs?: unknown; changed?: unknown } };
  assert.deepEqual(result.effects.newTabs, opened);
  assert.equal(result.effects.changed, true);
  const unchanged = { clicked: true };
  assert.equal(withOpenedTabs(unchanged, 'input.click', 5, 0, deps), unchanged);
  assert.equal(withOpenedTabs(unchanged, 'dom.query', 4, 0, deps), unchanged);
});
