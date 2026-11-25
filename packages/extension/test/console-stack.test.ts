import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_STACK_CHARS,
  MAX_STACK_FRAMES,
  boundUntrustedText,
  parseV8Stack,
} from '../src/console-stack.js';

test('parseV8Stack reads named, anonymous, async, and constructor frames', () => {
  const stack = [
    'TypeError: Cannot read properties of undefined',
    '    at validateOrder (https://app.test/assets/app.js:1:52)',
    '    at https://app.test/assets/app.js:1:120',
    '    at async loadAll (https://app.test/assets/app.js:2:10)',
    '    at new Widget (https://app.test/assets/widget.js?v=3:3:5)',
    '    at Object.<anonymous> [as run] (https://app.test/assets/app.js:4:1)',
  ].join('\n');
  assert.deepEqual(parseV8Stack(stack), [
    { function: 'validateOrder', url: 'https://app.test/assets/app.js', line: 1, column: 52 },
    { url: 'https://app.test/assets/app.js', line: 1, column: 120 },
    { function: 'loadAll', url: 'https://app.test/assets/app.js', line: 2, column: 10 },
    {
      function: 'new Widget',
      url: 'https://app.test/assets/widget.js?v=%5Bredacted%5D',
      line: 3,
      column: 5,
    },
    {
      function: 'Object.<anonymous> [as run]',
      url: 'https://app.test/assets/app.js',
      line: 4,
      column: 1,
    },
  ]);
});

test('parseV8Stack reports eval and new Function frames at their call site', () => {
  const stack = [
    'Error: from eval',
    '    at eval (eval at run (https://app.test/app.js:4:9), <anonymous>:1:7)',
    '    at anonymous (eval at create (https://app.test/app.js:5:11), <anonymous>:3:9)',
    '    at eval (eval at outer (eval at inner (https://app.test/app.js:6:2), <anonymous>:1:1), <anonymous>:2:2)',
    '    at Array.map (<anonymous>)',
    '    at async Promise.all (index 0)',
  ].join('\n');
  assert.deepEqual(parseV8Stack(stack), [
    { function: 'eval', url: 'https://app.test/app.js', line: 4, column: 9 },
    { function: 'anonymous', url: 'https://app.test/app.js', line: 5, column: 11 },
    { function: 'eval', url: 'https://app.test/app.js', line: 6, column: 2 },
  ]);
});

test('parseV8Stack ignores garbage and never throws', () => {
  for (const value of [
    undefined,
    null,
    42,
    {},
    ['    at a (https://x.test/a.js:1:1)'],
    '',
    'not a stack at all',
    '    at (:1:2)',
    '    at broken (https://x.test/a.js:0:0)',
    '    at huge (https://x.test/a.js:99999999999:1)',
    '    at relative (/assets/a.js:1:1)',
    '    at nested (((((((',
  ]) {
    assert.deepEqual(parseV8Stack(value), []);
  }
});

test('parseV8Stack bounds a 10,000-line stack to eight frames and 1,500 characters', () => {
  const frames = Array.from(
    { length: 10_000 },
    (_, index) => `    at f${index} (https://app.test/a.js:${index + 1}:1)`
  );
  const parsed = parseV8Stack(`Error: deep\n${frames.join('\n')}`);
  assert.equal(parsed.length, MAX_STACK_FRAMES);
  assert.equal(parsed[0].function, 'f0');
  assert.equal(parsed[7].function, 'f7');

  // Frames past the character budget are never parsed, even when few.
  const padded = `Error: ${'x'.repeat(MAX_STACK_CHARS)}\n    at late (https://app.test/a.js:1:1)`;
  assert.deepEqual(parseV8Stack(padded), []);
});

test('parseV8Stack strips control and bidi characters from function names and URLs', () => {
  const rlo = String.fromCodePoint(0x202e);
  const esc = String.fromCodePoint(0x1b);
  const name = `evil${rlo}Name${esc}[31m${'n'.repeat(500)}`;
  const [frame] = parseV8Stack(`Error\n    at ${name} (https://app.test/a.js:1:1)`);
  assert.ok(frame.function);
  assert.equal(frame.function.includes(rlo), false);
  assert.equal(frame.function.includes(esc), false);
  assert.ok(frame.function.startsWith('evilName[31m'));
  assert.ok(frame.function.length <= 200);
});

test('boundUntrustedText removes unsafe code points and bounds length', () => {
  const unsafe = [0x00, 0x1f, 0x7f, 0x9f, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]
    .map((code) => String.fromCodePoint(code))
    .join('');
  assert.equal(boundUntrustedText(`a${unsafe}b`, 10), 'ab');
  assert.equal(boundUntrustedText('abcdef', 3), 'abc');
  assert.equal(boundUntrustedText('src/über.ts', 50), 'src/über.ts');
});
