import test from 'node:test';
import assert from 'node:assert/strict';

import { withDocument } from '../../../tests/_helpers/dom.ts';

type BaselineNode = {
  nodeId: string;
  parentId: string | null;
  ancestorIds: string[];
  siblingIndex: number;
  order: number;
  depth: number;
  tag: string;
  role: string | null;
  name: string | null;
  nameFingerprint: string;
  textExcerpt: string;
  textFingerprint: string;
  attrs: Record<string, { value: string; fingerprint: string }>;
  attrsFingerprint: string;
  state: Record<string, boolean | 'mixed'>;
};

type BaselineSnapshot = {
  documentToken: string;
  representation: 'semantic-dom-v1';
  selector: string;
  nodes: BaselineNode[];
  stats: { nodeCount: number; byteLength: number; digest: string };
};

type BaselineApi = {
  capture(params: {
    selector: string;
    maxNodes: number;
    maxDepth: number;
    textBudget: number;
    attributeAllowlist: string[];
    expectedDocumentToken?: string;
    allowMissingRoot?: boolean;
  }): BaselineSnapshot;
  getDocumentToken(): string;
};

const MISSING = Symbol('missing');

async function importFresh(relativePath: string): Promise<void> {
  await import(
    `${new URL(relativePath, import.meta.url).href}?case=${Date.now()}-${Math.random()}`
  );
}

async function loadBaseline(t: import('node:test').TestContext): Promise<BaselineApi> {
  const keys = ['__BBX_CONTENT_HELPERS__', '__bbxContentDomBaseline'];
  const saved = new Map<string, unknown>();
  for (const key of keys) {
    saved.set(
      key,
      Object.prototype.hasOwnProperty.call(globalThis, key) ? Reflect.get(globalThis, key) : MISSING
    );
    Reflect.deleteProperty(globalThis, key);
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === MISSING) Reflect.deleteProperty(globalThis, key);
      else Reflect.set(globalThis, key, value);
    }
  });

  await importFresh('../src/content-script-helpers.js');
  await importFresh('../src/content-dom-baseline.js');
  const baseline = Reflect.get(globalThis, '__bbxContentDomBaseline') as BaselineApi | undefined;
  assert.ok(baseline);
  return baseline;
}

function capture(
  baseline: BaselineApi,
  overrides: Partial<Parameters<BaselineApi['capture']>[0]> = {}
) {
  return baseline.capture({
    selector: '#root',
    maxNodes: 100,
    maxDepth: 10,
    textBudget: 1000,
    attributeAllowlist: [],
    ...overrides,
  });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

test('semantic baseline snapshots are deterministic within a document', async (t) => {
  await withDocument('<main id="root"><p>Hello world</p><button>Save</button></main>', async () => {
    const baseline = await loadBaseline(t);
    const first = capture(baseline);
    const second = capture(baseline);

    assert.deepEqual(second, first);
    assert.equal(first.documentToken, baseline.getDocumentToken());
    assert.match(first.documentToken, /^doc_[0-9a-f]{32}$/);
    assert.equal(first.representation, 'semantic-dom-v1');
    assert.equal(first.stats.nodeCount, 3);
    assert.equal(
      first.stats.byteLength,
      new TextEncoder().encode(JSON.stringify(first)).byteLength
    );
    assert.match(first.stats.digest, /^\d+:[0-9a-f]{16}$/);
  });
});

test('semantic baseline enforces a unique valid selector', async (t) => {
  await withDocument('<main><div class="item"></div><div class="item"></div></main>', async () => {
    const baseline = await loadBaseline(t);
    const params = {
      maxNodes: 10,
      maxDepth: 3,
      textBudget: 100,
      attributeAllowlist: [],
    };

    assert.throws(
      () => baseline.capture({ ...params, selector: '#missing' }),
      (error) => {
        return errorCode(error) === 'ELEMENT_NOT_FOUND';
      }
    );
    assert.deepEqual(
      baseline.capture({ ...params, selector: '#missing', allowMissingRoot: true }).nodes,
      []
    );
    assert.throws(
      () => baseline.capture({ ...params, selector: '.item' }),
      (error) => {
        return errorCode(error) === 'ELEMENT_AMBIGUOUS';
      }
    );
    assert.throws(
      () => baseline.capture({ ...params, selector: '[' }),
      (error) => {
        return errorCode(error) === 'INVALID_REQUEST';
      }
    );
  });
});

test('semantic baseline excludes secrets, event handlers, and excluded subtrees without DOM mutations', async (t) => {
  await withDocument(
    '<main id="root"><input id="password" type="password" value="correct-horse" onclick="steal()" class="field" aria-labelledby="script-label"><a href="https://user:pass@example.test/account?token=secret#private">Account</a><script id="script-label">window.secret="script-secret"</script><style>.secret{}</style></main>',
    async ({ document }) => {
      const baseline = await loadBaseline(t);
      const before = document.documentElement.outerHTML;
      const result = capture(baseline, {
        attributeAllowlist: ['value', 'onclick', 'class'],
      });
      const serialized = JSON.stringify(result);

      assert.equal(document.documentElement.outerHTML, before);
      assert.equal(serialized.includes('correct-horse'), false);
      assert.equal(serialized.includes('steal()'), false);
      assert.equal(serialized.includes('script-secret'), false);
      assert.equal(serialized.includes('.secret'), false);
      assert.equal(serialized.includes('user:pass'), false);
      assert.equal(serialized.includes('token=secret'), false);
      assert.equal(serialized.includes('#private'), false);
      assert.equal(serialized.includes('elementRef'), false);
      assert.equal(serialized.includes('bbox'), false);
      assert.deepEqual(
        result.nodes.map((node) => node.tag),
        ['main', 'input', 'a']
      );
      assert.deepEqual(Object.keys(result.nodes[1].attrs), ['class', 'id', 'type']);
    }
  );
});

test('semantic baseline keeps document and element identity across reinjection', async (t) => {
  await withDocument('<main id="root"><span>Stable</span></main>', async () => {
    const baseline = await loadBaseline(t);
    const first = capture(baseline);

    await importFresh('../src/content-dom-baseline.js');
    const reinjected = Reflect.get(globalThis, '__bbxContentDomBaseline') as BaselineApi;
    const second = capture(reinjected);

    assert.equal(reinjected, baseline);
    assert.equal(second.documentToken, first.documentToken);
    assert.deepEqual(
      second.nodes.map((node) => node.nodeId),
      first.nodes.map((node) => node.nodeId)
    );
  });
});

test('semantic baseline fingerprints complete equal-length text', async (t) => {
  await withDocument('<main id="root"><p id="copy">alpha</p></main>', async ({ document }) => {
    const baseline = await loadBaseline(t);
    const first = capture(baseline);
    const copy = document.getElementById('copy');
    assert.ok(copy);
    copy.textContent = 'bravo';
    const second = capture(baseline);

    assert.equal(first.nodes[1].nodeId, second.nodes[1].nodeId);
    assert.notEqual(first.nodes[1].textFingerprint, second.nodes[1].textFingerprint);
    assert.notEqual(first.stats.digest, second.stats.digest);
  });
});

test('semantic baseline captures roles, names, sorted attrs, ancestry, order, and state', async (t) => {
  await withDocument(
    '<main id="root"><section id="panel"><span id="label">Save account</span><button id="save" data-testid="save-button" aria-labelledby="label" aria-expanded="false" disabled>Fallback</button><input id="choice" type="checkbox" checked><div id="toggle" role="button" aria-pressed="mixed" title="Toggle mode"></div></section></main>',
    async () => {
      const baseline = await loadBaseline(t);
      const result = capture(baseline, { attributeAllowlist: ['aria-label'] });
      const [root, panel, label, button, checkbox, toggle] = result.nodes;

      assert.equal(root.role, 'main');
      assert.equal(button.role, 'button');
      assert.equal(button.name, 'Save account');
      assert.deepEqual(Object.keys(button.attrs), ['data-testid', 'id']);
      assert.equal(button.parentId, panel.nodeId);
      assert.deepEqual(button.ancestorIds, [root.nodeId, panel.nodeId]);
      assert.equal(button.siblingIndex, 1);
      assert.deepEqual(
        result.nodes.map((node) => [node.tag, node.order, node.depth]),
        [
          ['main', 0, 0],
          ['section', 1, 1],
          ['span', 2, 2],
          ['button', 3, 2],
          ['input', 4, 2],
          ['div', 5, 2],
        ]
      );
      assert.deepEqual(button.state, { disabled: true, expanded: false });
      assert.deepEqual(checkbox.state, { disabled: false, checked: true });
      assert.deepEqual(toggle.state, { pressed: 'mixed' });
      assert.equal(label.textExcerpt, 'Save account');
      assert.match(label.textFingerprint, /^12:/);
    }
  );
});

test('semantic baseline applies the text budget independently to each node', async (t) => {
  await withDocument(
    `<main id="root"><p>${'a'.repeat(100)}</p><p>${'b'.repeat(100)}</p></main>`,
    async () => {
      const baseline = await loadBaseline(t);
      const result = capture(baseline, { textBudget: 32 });
      const paragraphs = result.nodes.filter((node) => node.tag === 'p');
      assert.equal(paragraphs.length, 2);
      assert.equal(
        paragraphs.every((node) => node.textExcerpt.length > 0),
        true
      );
      assert.equal(
        paragraphs.every((node) => node.textExcerpt.length <= 32),
        true
      );
      const expanded = capture(baseline, { textBudget: 200 });
      assert.equal(
        expanded.nodes
          .filter((node) => node.tag === 'p')
          .every((node) => node.textExcerpt.length === 100),
        true
      );
    }
  );
});

test('semantic baseline keeps accessible-name references inside selector scope', async (t) => {
  await withDocument(
    '<div id="outside">outside-secret</div><main><button id="target" aria-labelledby="outside">Fallback</button></main>',
    async () => {
      const baseline = await loadBaseline(t);
      const result = capture(baseline, { selector: '#target' });
      assert.equal(JSON.stringify(result).includes('outside-secret'), false);
      assert.equal(result.nodes[0].name, 'Fallback');
    }
  );
});

test('semantic baseline redacts opaque href payloads', async (t) => {
  await withDocument(
    '<main id="root"><a href="data:text/plain,private-payload">Open</a></main>',
    async () => {
      const baseline = await loadBaseline(t);
      const result = capture(baseline);
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes('private-payload'), false);
      assert.match(
        result.nodes.find((node) => node.tag === 'a')?.attrs.href.value ?? '',
        /^(?:|data:\[redacted\])$/u
      );
    }
  );
});

test('semantic baseline reads live checked and selected state instead of stale attributes', async (t) => {
  await withDocument(
    '<main id="root"><input id="check" type="checkbox" checked><select><option id="option" selected>One</option><option>Two</option></select></main>',
    async ({ document }) => {
      const baseline = await loadBaseline(t);
      const before = capture(baseline);
      (document.querySelector('#check') as HTMLInputElement).checked = false;
      (document.querySelector('#option') as HTMLOptionElement).selected = false;
      const after = capture(baseline);
      assert.equal(before.nodes.find((node) => node.tag === 'input')?.state.checked, true);
      assert.equal(after.nodes.find((node) => node.tag === 'input')?.state.checked, false);
      const option = after.nodes.find((node) => node.tag === 'option');
      assert.equal(option?.state.selected, false);
    }
  );
});

test('semantic baseline rejects unbounded source strings before fingerprinting', async (t) => {
  await withDocument(`<main id="root"><span>${'x'.repeat(40_000)}</span></main>`, async () => {
    const baseline = await loadBaseline(t);
    assert.throws(
      () => capture(baseline),
      (error) => errorCode(error) === 'RESULT_TRUNCATED'
    );
  });
});

test('semantic baseline fails atomically on node, depth, and byte bounds', async (t) => {
  const children = Array.from({ length: 999 }, (_, index) => `<i id="n${index}"></i>`).join('');
  await withDocument(`<main id="root"><div><span></span></div>${children}</main>`, async () => {
    const baseline = await loadBaseline(t);

    assert.throws(
      () => capture(baseline, { maxNodes: 1 }),
      (error) => {
        return errorCode(error) === 'RESULT_TRUNCATED';
      }
    );
    assert.throws(
      () => capture(baseline, { maxDepth: 1 }),
      (error) => {
        return errorCode(error) === 'RESULT_TRUNCATED';
      }
    );
    assert.throws(
      () =>
        capture(baseline, {
          maxNodes: 1000,
          maxDepth: 2,
          textBudget: 32,
        }),
      (error) => errorCode(error) === 'RESULT_TRUNCATED'
    );
  });
});

test('semantic baseline rejects a mismatched expected document token', async (t) => {
  await withDocument('<main id="root"></main>', async () => {
    const baseline = await loadBaseline(t);

    assert.throws(
      () => capture(baseline, { expectedDocumentToken: 'doc_from_another_document' }),
      (error) => errorCode(error) === 'DOM_BASELINE_INVALIDATED'
    );
  });
});
