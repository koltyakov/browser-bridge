// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { SHORTCUT_COMMANDS } from '../src/command-registry.js';

test('shortcut commands build expected params for common inputs', () => {
  assert.deepEqual(SHORTCUT_COMMANDS['access-request'].build([]), {});
  assert.deepEqual(SHORTCUT_COMMANDS['dom-query'].build(['.app']), { selector: '.app' });
  assert.deepEqual(SHORTCUT_COMMANDS.describe.build([], 'el_1'), { elementRef: 'el_1' });
  assert.deepEqual(SHORTCUT_COMMANDS.text.build(['button', '150'], 'el_2'), {
    elementRef: 'el_2',
    textBudget: 150,
  });
  assert.deepEqual(SHORTCUT_COMMANDS.styles.build(['button', 'display,color'], 'el_3'), {
    elementRef: 'el_3',
    properties: ['display', 'color'],
  });
  assert.deepEqual(SHORTCUT_COMMANDS.box.build([], 'el_4'), { elementRef: 'el_4' });
  assert.deepEqual(SHORTCUT_COMMANDS.click.build(['button', 'right'], 'el_5'), {
    target: { elementRef: 'el_5' },
    button: 'right',
  });
  assert.deepEqual(SHORTCUT_COMMANDS.focus.build([], 'el_6'), {
    target: { elementRef: 'el_6' },
  });
  assert.deepEqual(SHORTCUT_COMMANDS.type.build(['input', 'hello', 'world'], 'el_7'), {
    target: { elementRef: 'el_7' },
    text: 'hello world',
  });
  assert.deepEqual(SHORTCUT_COMMANDS.hover.build([], 'el_8'), {
    target: { elementRef: 'el_8' },
  });
  assert.deepEqual(SHORTCUT_COMMANDS.html.build(['main', '2048'], 'el_9'), {
    elementRef: 'el_9',
    maxLength: 2048,
  });
  assert.deepEqual(
    SHORTCUT_COMMANDS['patch-style'].build(['panel', 'display=flex', 'gap=8px'], 'el_10'),
    {
      target: { elementRef: 'el_10' },
      declarations: { display: 'flex', gap: '8px' },
    }
  );
  assert.deepEqual(SHORTCUT_COMMANDS['patch-text'].build(['panel', 'Updated', 'text'], 'el_11'), {
    target: { elementRef: 'el_11' },
    operation: 'set_text',
    value: 'Updated text',
  });
  assert.deepEqual(SHORTCUT_COMMANDS.patches.build([]), {});
  assert.deepEqual(SHORTCUT_COMMANDS.rollback.build(['patch-1']), { patchId: 'patch-1' });
  assert.deepEqual(SHORTCUT_COMMANDS.console.build(['warn']), { level: 'warn', clear: false });
  assert.deepEqual(SHORTCUT_COMMANDS.wait.build(['.ready', '2500']), {
    selector: '.ready',
    timeoutMs: 2500,
  });
  assert.deepEqual(SHORTCUT_COMMANDS.find.build(['Submit', 'form']), { text: 'Submit form' });
  assert.deepEqual(SHORTCUT_COMMANDS['find-role'].build(['button', 'Submit', 'form']), {
    role: 'button',
    name: 'Submit form',
  });
  assert.deepEqual(SHORTCUT_COMMANDS.navigate.build(['https://example.com']), {
    url: 'https://example.com',
  });
  assert.deepEqual(SHORTCUT_COMMANDS.storage.build(['session', 'theme', 'token']), {
    type: 'session',
    keys: ['theme', 'token'],
  });
  assert.deepEqual(SHORTCUT_COMMANDS['page-text'].build(['200']), { textBudget: 200 });
  assert.deepEqual(SHORTCUT_COMMANDS.network.build(['10']), { limit: 10 });
  assert.deepEqual(SHORTCUT_COMMANDS['a11y-tree'].build(['25', '3']), {
    maxNodes: 25,
    maxDepth: 3,
  });
  assert.deepEqual(SHORTCUT_COMMANDS.perf.build([]), {});
  assert.deepEqual(SHORTCUT_COMMANDS.scroll.build(['120', '40']), { top: 120, left: 40 });
  assert.deepEqual(SHORTCUT_COMMANDS.resize.build(['800', '600']), {
    width: 800,
    height: 600,
  });
  assert.deepEqual(SHORTCUT_COMMANDS.reload.build([]), {});
  assert.deepEqual(SHORTCUT_COMMANDS.back.build([]), {});
  assert.deepEqual(SHORTCUT_COMMANDS.forward.build([]), {});
  assert.deepEqual(SHORTCUT_COMMANDS.attrs.build(['a', 'href,aria-label'], 'el_12'), {
    elementRef: 'el_12',
    attributes: ['href', 'aria-label'],
  });
  assert.deepEqual(SHORTCUT_COMMANDS['matched-rules'].build([], 'el_13'), {
    elementRef: 'el_13',
  });
});

test('shortcut commands apply documented defaults when optional args are omitted', () => {
  assert.deepEqual(SHORTCUT_COMMANDS['dom-query'].build([]), { selector: 'body' });
  assert.deepEqual(SHORTCUT_COMMANDS.console.build([]), { level: 'all', clear: false });
  assert.deepEqual(SHORTCUT_COMMANDS.storage.build([]), { type: 'local', keys: undefined });
  assert.deepEqual(SHORTCUT_COMMANDS.storage.build(['local']), { type: 'local', keys: undefined });
  assert.deepEqual(SHORTCUT_COMMANDS['page-text'].build([]), { textBudget: undefined });
  assert.deepEqual(SHORTCUT_COMMANDS.network.build([]), { limit: undefined });
  assert.deepEqual(SHORTCUT_COMMANDS['a11y-tree'].build([]), {
    maxNodes: undefined,
    maxDepth: undefined,
  });
  assert.deepEqual(SHORTCUT_COMMANDS.wait.build(['.ready']), {
    selector: '.ready',
    timeoutMs: 5000,
  });
  assert.deepEqual(SHORTCUT_COMMANDS['find-role'].build(['button']), {
    role: 'button',
    name: undefined,
  });
  assert.deepEqual(SHORTCUT_COMMANDS.scroll.build(['120']), { top: 120, left: undefined });
});

test('shortcut commands reject missing required arguments with usage errors', () => {
  assert.throws(() => SHORTCUT_COMMANDS.rollback.build([]), /Usage: rollback <patchId>/);
  assert.throws(() => SHORTCUT_COMMANDS.wait.build([]), /Usage: wait <selector> \[timeoutMs\]/);
  assert.throws(() => SHORTCUT_COMMANDS.find.build([]), /Usage: find <text>/);
  assert.throws(() => SHORTCUT_COMMANDS['find-role'].build([]), /Usage: find-role <role> \[name\]/);
  assert.throws(() => SHORTCUT_COMMANDS.navigate.build([]), /Usage: navigate <url>/);
  assert.throws(() => SHORTCUT_COMMANDS.scroll.build([]), /Usage: scroll <top> \[left\]/);
  assert.throws(() => SHORTCUT_COMMANDS.resize.build(['800']), /Usage: resize <width> <height>/);
});
