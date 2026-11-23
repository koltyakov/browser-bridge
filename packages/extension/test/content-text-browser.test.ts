import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chromeSkipReason,
  runContentCheckInChrome,
} from '../../../tests/_helpers/contentBrowser.ts';

async function checkVisibleText(): Promise<void> {
  const listener = Reflect.get(globalThis, '__bbxListener') as (
    message: { type: string; method: string; params: Record<string, unknown> },
    sender: object,
    respond: (value: Record<string, unknown>) => void
  ) => void;
  const call = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) =>
      listener({ type: 'bridge.execute', method, params }, {}, resolve)
    );
  const equal = (actual: unknown, expected: unknown, label: string): void => {
    if (actual !== expected)
      throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  };
  document.body.innerHTML =
    '<h1>Title</h1><x-card id="card"><span slot="body">Slotted body</span></x-card><p hidden>Secret</p><p>Tail</p>';
  const host = document.getElementById('card') as HTMLElement;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<h2>Shadow heading</h2><div><slot name="body"></slot></div><style>h2{}</style>';
  const page = await call('page.get_text', { textBudget: 8000 });
  equal(page.value, 'Title\nShadow heading\nSlotted body\nTail', 'shadow-aware page text');
  equal(page.truncated, false, 'complete read');

  const first = await call('page.get_text', { textBudget: 10 });
  equal(first.truncated, true, 'window truncated');
  equal(first.nextOffset, 9, 'next offset after the ellipsis');
  const second = await call('page.get_text', { textBudget: 100, offset: first.nextOffset });
  equal(
    String(first.value).slice(0, 9) + String(second.value),
    String(page.value),
    'windows rejoin'
  );

  document.body.innerHTML = '<article id="a"><p>One</p><p>Two</p></article>';
  const refs = await call('dom.query', { selector: '#a' });
  const ref = ((refs.nodes as Array<{ elementRef: string }>) ?? [])[0]?.elementRef;
  const element = await call('dom.get_text', { elementRef: ref, textBudget: 100, offset: 5 });
  equal(element.value, 'Two', 'element text offset');

  document.body.innerHTML = '<div id="h"></div><span class="item">light</span>';
  const shadow = (document.getElementById('h') as HTMLElement).attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button class="item"><span>S</span>ave</button>';
  const items = await call('dom.query', { selector: '.item' });
  equal(items.matchCount, 2, 'matchCount counts shadow matches');
  const hostQuery = await call('dom.query', { selector: '#h', maxDepth: 1 });
  const names = (hostQuery.nodes as Array<{ name: string | null; tag: string }>).map(
    (node) => node.name
  );
  equal(names.includes('Save'), true, 'children include shadow tree with accessible names');
}

test(
  'page and element text include shadow trees and continue from an offset in Chrome',
  { skip: chromeSkipReason, timeout: 60_000 },
  async () => {
    const result = await runContentCheckInChrome(checkVisibleText);
    assert.ok(result.passed, result.output.replace(/<[^>]+>/g, ''));
  }
);
