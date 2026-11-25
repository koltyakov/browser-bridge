import assert from 'node:assert/strict';
import test from 'node:test';
import { withDocument, type DocumentContext } from '../../../tests/_helpers/dom.ts';
import { extensionFile } from '../../../tests/_helpers/extensionBuild.ts';
import { executeInputPerform } from '../src/background-perform.js';
import { handleTabBoundRequest } from '../src/background-tab-bound.js';
import { createOutlineSnapshotStore } from '../src/background-outline-snapshots.js';
import { createFailure, createRequest } from '../../../protocol/src/index.js';
import type { BridgeRequest } from '../../../protocol/src/types.js';

type OutlineResult = import('../../../protocol/src/types.js').DomOutlineResult;
type OutlineNode = import('../../../protocol/src/types.js').DomOutlineNode;
type QueryApi = {
  getAccessibilityOutline: (params: Record<string, unknown>) => OutlineResult;
  clearOutlineSnapshots: () => { cleared: number };
};
type RegistryApi = {
  rememberElement: (element: Element) => string;
  getRequiredElement: (ref: string) => Element;
};
type OutlineContext = DocumentContext & {
  query: QueryApi;
  registry: RegistryApi;
  read: (params?: Record<string, unknown>) => OutlineResult;
};

const KEYS = ['__BBX_CONTENT_HELPERS__', '__BBX_CONTENT_REGISTRY__', '__BBX_CONTENT_DOM_QUERY__'];

/** Load the content modules into a fresh document, as one injection would. */
async function withOutline(
  body: string,
  run: (context: OutlineContext) => Promise<void> | void
): Promise<void> {
  await withDocument(`<!doctype html><html><body>${body}</body></html>`, async (context) => {
    const saved = KEYS.map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    );
    try {
      for (const key of KEYS) Reflect.deleteProperty(globalThis, key);
      // Linkedom has no layout engine; supply computed visibility.
      Reflect.set(globalThis, 'getComputedStyle', (element: HTMLElement) => ({
        display: element.style.display || 'block',
        visibility: element.style.visibility || 'visible',
      }));
      for (const name of [
        'content-script-helpers',
        'content-element-registry',
        'content-dom-query',
      ])
        await import(`${extensionFile(`src/${name}.js`).href}?case=${crypto.randomUUID()}`);
      const query = Reflect.get(globalThis, KEYS[2]) as QueryApi;
      await run({
        ...context,
        query,
        registry: Reflect.get(globalThis, KEYS[1]) as RegistryApi,
        read: (params = {}) => query.getAccessibilityOutline(params),
      });
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

const TODOS =
  '<main aria-label="Todos"><h1>Todos</h1><ul id="list">' +
  '<li id="milk"><input id="milk-box" type="checkbox" aria-label="Milk"></li>' +
  '<li id="eggs"><input id="eggs-box" type="checkbox" aria-label="Eggs"></li>' +
  '</ul><button id="clear">Clear</button></main>' +
  '<nav id="links" aria-label="Links"><a href="/a">About</a><a href="/b">Blog</a></nav>';

function lines(result: OutlineResult, key: 'added' | 'changed'): string[] {
  return (result.delta?.[key] ?? []) as string[];
}

function refOf(result: OutlineResult, pattern: RegExp): string {
  const line = (result.outline ?? '').split('\n').find((entry) => pattern.test(entry));
  const ref = line?.match(/\[(el_[^\]]+)\]/)?.[1];
  assert.ok(ref, `no line matches ${pattern}`);
  return ref;
}

test('reads without a snapshotId keep the existing shape', async () => {
  await withOutline(TODOS, ({ read }) => {
    const result = read();
    assert.equal(result.snapshotId, undefined);
    assert.equal(result.delta, undefined);
    assert.match(result.outline ?? '', /button "Clear"/);
  });
});

test('an unchanged page answers unchanged without walking the DOM', async () => {
  await withOutline(TODOS, ({ read }) => {
    const base = read({ snapshotId: 's1' });
    assert.equal(base.snapshotId, 's1');
    assert.equal(base.count, 8);
    const same = read({ since: 's1', snapshotId: 's2' });
    assert.deepEqual(same, {
      source: 'dom',
      format: 'outline',
      count: 8,
      scanned: 0,
      truncated: false,
      unchanged: true,
      snapshotId: 's2',
    });
    // The new snapshot stands for the same state.
    assert.equal(read({ since: 's2', snapshotId: 's3' }).unchanged, true);
  });
});

test('one added node returns only its line', async () => {
  await withOutline(TODOS, ({ read, document }) => {
    read({ snapshotId: 's1' });
    const item = document.createElement('li');
    item.innerHTML = '<input type="checkbox" aria-label="Bread">';
    document.getElementById('list')?.appendChild(item);
    const result = read({ since: 's1', snapshotId: 's2' });
    assert.equal(result.outline, undefined);
    assert.equal(result.count, 9);
    assert.deepEqual(lines(result, 'changed'), []);
    assert.deepEqual(result.delta?.removed, []);
    const added = lines(result, 'added');
    assert.equal(added.length, 1);
    assert.match(added[0], /^ {2}- checkbox "Bread" \[el_/);
  });
});

test('one removed node returns only its ref', async () => {
  await withOutline(TODOS, ({ read, document }) => {
    const base = read({ snapshotId: 's1' });
    const milk = refOf(base, /Milk/);
    document.getElementById('milk')?.remove();
    const result = read({ since: 's1', snapshotId: 's2' });
    assert.deepEqual(result.delta, { added: [], changed: [], removed: [milk] });
  });
});

test('a rename and a property-only checkbox toggle are changed lines', async () => {
  await withOutline(TODOS, ({ read, document }) => {
    read({ snapshotId: 's1' });
    const clear = document.getElementById('clear');
    assert.ok(clear);
    clear.textContent = 'Clear completed';
    const renamed = read({ since: 's1', snapshotId: 's2' });
    assert.deepEqual(lines(renamed, 'changed'), [
      `  - button "Clear completed" [${refOf(read(), /Clear completed/)}]`,
    ]);
    // A script setting .checked changes no attribute, so no mutation is
    // recorded. The no-walk path must still notice.
    const box = document.getElementById('milk-box');
    assert.ok(box);
    Object.defineProperty(box, 'checked', { value: true, configurable: true });
    const toggled = read({ since: 's2', snapshotId: 's3' });
    const changed = lines(toggled, 'changed');
    assert.equal(changed.length, 1);
    assert.match(changed[0], /checkbox "Milk" \[el_[^\]]+\] checked$/);
  });
});

test('a reorder reports the moved line, not every sibling', async () => {
  await withOutline(TODOS, ({ read, document }) => {
    const base = read({ snapshotId: 's1' });
    const list = document.getElementById('list');
    const eggs = document.getElementById('eggs');
    assert.ok(list && eggs);
    list.insertBefore(eggs, document.getElementById('milk'));
    const result = read({ since: 's1', snapshotId: 's2' });
    const changed = lines(result, 'changed');
    assert.equal(changed.length, 1);
    assert.ok([refOf(base, /Milk/), refOf(base, /Eggs/)].some((ref) => changed[0].includes(ref)));
    assert.deepEqual(lines(result, 'added'), []);
    assert.deepEqual(result.delta?.removed, []);
  });
});

test('a move to a new parent is a changed line with its new depth', async () => {
  await withOutline(TODOS, ({ read, document }) => {
    const base = read({ snapshotId: 's1' });
    const clear = document.getElementById('clear');
    assert.ok(clear);
    document.getElementById('links')?.appendChild(clear);
    const result = read({ since: 's1', snapshotId: 's2' });
    assert.deepEqual(lines(result, 'changed'), [
      `  - button "Clear" [${refOf(base, /button "Clear"/)}]`,
    ]);
  });
});

test('tree format deltas carry nodes', async () => {
  await withOutline(TODOS, ({ read, document }) => {
    read({ snapshotId: 's1', format: 'tree' });
    const button = document.createElement('button');
    button.textContent = 'Add';
    document.querySelector('main')?.appendChild(button);
    const result = read({ since: 's1', snapshotId: 's2', format: 'tree' });
    assert.equal(result.format, 'tree');
    assert.equal(result.nodes, undefined);
    const added = result.delta?.added as OutlineNode[];
    assert.equal(added.length, 1);
    assert.equal(added[0].role, 'button');
    assert.equal(added[0].name, 'Add');
  });
});

test('a base cut at maxNodes returns base_truncated instead of claiming added lines', async () => {
  const buttons = Array.from({ length: 12 }, (_, index) => `<button>B${index}</button>`).join('');
  await withOutline(buttons, ({ read, document }) => {
    const base = read({ snapshotId: 's1', maxNodes: 10 });
    assert.equal(base.count, 10);
    assert.equal(base.truncated, true);
    document.body.firstElementChild?.remove();
    const result = read({ since: 's1', snapshotId: 's2', maxNodes: 10 });
    assert.equal(result.deltaUnavailable, 'base_truncated');
    assert.equal(result.delta, undefined);
    assert.match(result.outline ?? '', /B10/);
  });
});

test('refs pruned between reads return refs_pruned', async () => {
  await withOutline(TODOS, ({ read, registry, document }) => {
    read({ snapshotId: 's1' });
    // The registry holds 5000 refs; more forces pruning or eviction.
    for (let index = 0; index < 5005; index += 1)
      registry.rememberElement(document.createElement('span'));
    const result = read({ since: 's1', snapshotId: 's2' });
    assert.equal(result.deltaUnavailable, 'refs_pruned');
    assert.match(result.outline ?? '', /button "Clear"/);
  });
});

test('opening a modal under scope auto returns scope_changed with the modal outline', async () => {
  await withOutline('<main aria-label="App"><button>Open</button></main>', ({ read, document }) => {
    const base = read({ scope: 'auto', snapshotId: 's1' });
    assert.equal(base.scope?.resolved, 'main');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Confirm');
    dialog.innerHTML = '<button>OK</button>';
    document.body.appendChild(dialog);
    const result = read({ scope: 'auto', since: 's1', snapshotId: 's2' });
    assert.equal(result.deltaUnavailable, 'scope_changed');
    assert.equal(result.scope?.resolved, 'modal');
    assert.match(result.outline ?? '', /dialog "Confirm"/);
    assert.match(result.outline ?? '', /button "OK"/);
    assert.doesNotMatch(result.outline ?? '', /Open/);
  });
});

test('different read params return scope_changed', async () => {
  await withOutline(TODOS, ({ read }) => {
    read({ snapshotId: 's1' });
    assert.equal(
      read({ since: 's1', snapshotId: 's2', interactiveOnly: true }).deltaUnavailable,
      'scope_changed'
    );
  });
});

test('an ID from an earlier document returns navigated', async () => {
  let id = '';
  await withOutline(TODOS, ({ read }) => {
    id = String(read({ snapshotId: 'from-old-document' }).snapshotId);
  });
  await withOutline(TODOS, ({ read }) => {
    const result = read({ since: id, snapshotId: 's2' });
    assert.equal(result.deltaUnavailable, 'navigated');
    assert.match(result.outline ?? '', /button "Clear"/);
  });
});

test('a fifth snapshot evicts the first, and clearing forgets all of them', async () => {
  await withOutline(TODOS, ({ read, query }) => {
    for (const id of ['s1', 's2', 's3', 's4', 's5']) read({ snapshotId: id });
    assert.equal(read({ since: 's1' }).deltaUnavailable, 'evicted');
    assert.equal(read({ since: 's2' }).unchanged, true);
    assert.deepEqual(query.clearOutlineSnapshots(), { cleared: 4 });
    assert.equal(read({ since: 's5' }).deltaUnavailable, 'navigated');
  });
});

test('snapshots expire after five minutes', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  await withOutline(TODOS, ({ read }) => {
    read({ snapshotId: 's1' });
    now += 6 * 60_000;
    assert.equal(read({ since: 's1', snapshotId: 's2' }).deltaUnavailable, 'expired');
  });
});

test('a delta larger than most of the outline returns the outline', async () => {
  await withOutline(TODOS, ({ read, document }) => {
    read({ snapshotId: 's1' });
    document.querySelector('main')?.replaceChildren();
    const nav = document.getElementById('links');
    assert.ok(nav);
    nav.innerHTML = '<a href="/c">Careers</a><a href="/d">Docs</a><a href="/e">Events</a>';
    const result = read({ since: 's1', snapshotId: 's2' });
    assert.equal(result.deltaUnavailable, 'delta_too_large');
    assert.match(result.outline ?? '', /link "Careers"/);
  });
});

test('interaction events make the next read walk instead of trusting the counter', async () => {
  await withOutline(TODOS, ({ read, document, window }) => {
    read({ snapshotId: 's1' });
    document
      .getElementById('clear')
      ?.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
    const result = read({ since: 's1', snapshotId: 's2' });
    assert.equal(result.unchanged, true);
    assert.ok(result.scanned > 0, 'a CSS :hover change has no mutation to count');
  });
});

test('input.perform with a click and an outline step returns the delta in one call', async () => {
  await withOutline(TODOS, async ({ query, document }) => {
    const clicks: string[] = [];
    // The background path for one tab, with this document as its only frame.
    const tabBound = {
      contentScriptTimeoutMs: 1000,
      outlineSnapshots: createOutlineSnapshotStore(),
      resolveRequestTarget: async () => ({
        tabId: 3,
        windowId: 1,
        title: 'Todos',
        url: 'https://todo.test/',
      }),
      ensureContentScript: async () => {},
      handleScreenshot: async () => ({}),
      handleNativeInput: async () => ({}),
      toFailureResponse: (request: BridgeRequest, error: unknown) =>
        createFailure(request.id, 'INTERNAL_ERROR', String(error)),
      sendTabMessage: async (_tabId: number, message: Record<string, unknown>) => {
        const params = message.params as Record<string, unknown>;
        if (message.method === 'dom.get_accessibility_tree')
          return query.getAccessibilityOutline(params);
        // The click's effect: the app adds a todo.
        clicks.push(String(message.method));
        const item = document.createElement('li');
        item.innerHTML = '<input type="checkbox" aria-label="Bread">';
        document.getElementById('list')?.appendChild(item);
        return { clicked: true };
      },
    };
    const dispatch = (request: BridgeRequest) => handleTabBoundRequest(request, tabBound as never);
    const base = await dispatch(
      createRequest({ id: 'base', method: 'dom.get_accessibility_tree', params: { source: 'dom' } })
    );
    assert.equal(base.ok, true);
    const snapshotId = (base.result as OutlineResult).snapshotId;
    assert.match(String(snapshotId), /^ol_[a-z0-9]{12}$/);
    const response = await executeInputPerform(
      createRequest({
        id: 'perform',
        method: 'input.perform',
        params: {
          returnLastResult: true,
          steps: [
            { method: 'input.click', params: { target: { selector: '#clear' } } },
            { method: 'dom.get_accessibility_tree', params: { since: snapshotId } },
          ],
        },
      }),
      { resolveRequestTarget: async () => ({ tabId: 3 }), dispatch }
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.deepEqual(clicks, ['input.click']);
    const last = (response.result as { lastResult: { result: OutlineResult } }).lastResult.result;
    assert.notEqual(last.snapshotId, snapshotId);
    assert.equal(last.outline, undefined);
    assert.equal(lines(last, 'added').length, 1);
    assert.match(lines(last, 'added')[0], /checkbox "Bread"/);
    assert.deepEqual(last.delta?.removed, []);
  });
});

test('shadow DOM additions appear in the delta although the counter cannot see them', async () => {
  await withOutline('<main aria-label="App"><div id="host"></div></main>', ({ read, document }) => {
    const host = document.getElementById('host');
    assert.ok(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Save</button>';
    read({ snapshotId: 's1' });
    // No change: still a walk, because the base crossed a shadow root.
    const same = read({ since: 's1', snapshotId: 's2' });
    assert.equal(same.unchanged, true);
    assert.ok(same.scanned > 0);
    const extra = document.createElement('button');
    extra.textContent = 'Publish';
    shadow.appendChild(extra);
    const result = read({ since: 's2', snapshotId: 's3' });
    const added = lines(result, 'added');
    assert.equal(added.length, 1);
    assert.match(added[0], /button "Publish"/);
  });
});
