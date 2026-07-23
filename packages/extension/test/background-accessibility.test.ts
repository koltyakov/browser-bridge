import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAccessibilityTree,
  scopeAccessibilityNodes,
  simplifyAXNode,
} from '../src/background-accessibility.js';

test('AX simplification parses real CDP properties and separates semantics from actionability', () => {
  const node = simplifyAXNode({
    nodeId: 'control',
    role: { type: 'role', value: 'checkbox' },
    name: { type: 'computedString', value: 'Remember me' },
    properties: [
      { name: 'focusable', value: { type: 'booleanOrUndefined', value: true } },
      { name: 'focused', value: { type: 'booleanOrUndefined', value: true } },
      { name: 'required', value: { type: 'boolean', value: true } },
      { name: 'checked', value: { type: 'tristate', value: 'mixed' } },
      { name: 'disabled', value: { type: 'boolean', value: true } },
    ],
  });

  assert.equal(node.semanticInteractive, true);
  assert.equal(node.interactive, true);
  assert.equal(node.focusableAndEnabled, false);
  assert.equal(node.focused, true);
  assert.equal(node.required, true);
  assert.equal(node.checked, 'mixed');
  assert.equal(node.disabled, true);
});

test('AX focusability can be reported without claiming semantic interactivity', () => {
  const node = simplifyAXNode({
    nodeId: 'focusable-generic',
    role: { value: 'generic' },
    properties: [{ name: 'focusable', value: { value: true } }],
  });
  assert.equal(node.semanticInteractive, false);
  assert.equal(node.interactive, true);
  assert.equal(node.focusableAndEnabled, true);
});

test('compact AX filtering promotes meaningful descendants through ignored and empty wrappers', () => {
  const tree = buildAccessibilityTree(
    [
      { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['ignored'] },
      { nodeId: 'ignored', ignored: true, role: { value: 'none' }, childIds: ['empty'] },
      { nodeId: 'empty', role: { value: 'generic' }, childIds: ['label', 'button'] },
      { nodeId: 'label', role: { value: 'StaticText' }, name: { value: 'Account' } },
      {
        nodeId: 'button',
        role: { value: 'button' },
        name: { value: 'Open' },
        properties: [{ name: 'disabled', value: { value: true } }],
      },
    ],
    { compact: true, interactiveOnly: false, maxNodes: 10 }
  );

  assert.deepEqual(
    tree.nodes.map((node) => node.nodeId),
    ['root', 'label', 'button']
  );
  assert.deepEqual(tree.nodes[0]?.childIds, ['label', 'button']);
  assert.deepEqual(tree.rootIds, ['root']);
  assert.equal(tree.nodes[2]?.semanticInteractive, true);
  assert.equal(tree.nodes[2]?.focusableAndEnabled, false);
});

test('interactive-only AX filtering happens before maxNodes and excludes ignored controls', () => {
  const rawNodes: Array<Record<string, unknown>> = Array.from({ length: 20 }, (_, index) => ({
    nodeId: `text-${index}`,
    role: { value: 'StaticText' },
    name: { value: `Label ${index}` },
  }));
  rawNodes.push(
    {
      nodeId: 'hidden-button',
      ignored: true,
      role: { value: 'button' },
      name: { value: 'Hidden' },
    },
    {
      nodeId: 'menu-item',
      role: { value: 'menuitem' },
      name: { value: 'Visible item' },
      childIds: ['stale-backend-node'],
    }
  );

  const tree = buildAccessibilityTree(rawNodes, {
    compact: false,
    interactiveOnly: true,
    maxNodes: 1,
  });

  assert.deepEqual(
    tree.nodes.map((node) => node.nodeId),
    ['menu-item']
  );
  assert.deepEqual(tree.nodes[0]?.childIds, []);
  assert.equal(tree.filteredCount, 1);
  assert.equal(tree.truncated, false);
  assert.equal(tree.missingChildCount, 1);
});

test('AX filtering reports empty and truncated trees without dangling relationships', () => {
  const empty = buildAccessibilityTree(
    [{ nodeId: 'decorative', role: { value: 'presentation' } }],
    { compact: true, interactiveOnly: false, maxNodes: 10 }
  );
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.rootIds, []);

  const truncated = buildAccessibilityTree(
    [
      { nodeId: 'one', role: { value: 'button' }, childIds: ['two'] },
      { nodeId: 'two', role: { value: 'link' }, childIds: ['three'] },
      { nodeId: 'three', role: { value: 'textbox' } },
    ],
    { compact: false, interactiveOnly: true, maxNodes: 2 }
  );
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.omitted, 1);
  assert.deepEqual(truncated.nodes[1]?.childIds, []);
});

test('partial AX scoping retains the target subtree and ancestors but removes siblings', () => {
  const scoped = scopeAccessibilityNodes(
    [
      { nodeId: 'root', childIds: ['dialog', 'sidebar'] },
      { nodeId: 'dialog', backendDOMNodeId: 42, childIds: ['button', 'group'] },
      { nodeId: 'button', childIds: [] },
      { nodeId: 'group', childIds: ['deep'] },
      { nodeId: 'deep', childIds: [] },
      { nodeId: 'sidebar', childIds: ['link'] },
      { nodeId: 'link', childIds: [] },
    ],
    42,
    1
  );

  assert.deepEqual(
    scoped.map((node) => node.nodeId),
    ['root', 'dialog', 'button', 'group']
  );
  assert.deepEqual(scopeAccessibilityNodes([{ nodeId: 'root' }], 99, 3), []);
});
