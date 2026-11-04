import test from 'node:test';
import assert from 'node:assert/strict';
import { compileUrlPattern } from '../src/background-url-pattern.js';

test('URL patterns preserve Chromium wildcard, escape, Unicode and case semantics', () => {
  // Includes the base::MatchPattern cases used by Chromium's Fetch interceptor.
  const cases: Array<[string, string, boolean]> = [
    ['*.com', 'www.google.com', true],
    ['*.COM', 'www.google.com', false],
    ['H?l?o', 'Hello', true],
    ['He??o\\*1*', 'Hello*1234', true],
    ['*.*', '', false],
    ['*', '', true],
    ['?', '', true],
    ['', '', true],
    ['', 'Hello', false],
    ['*???', 'abcd', true],
    ['???', 'abcd', false],
    ['a*b', 'abcb', true],
    ['a?b', 'abcb', false],
    ['heart: ?.', 'heart: ♠.', true],
    ['heart: ?.', 'heart: 💛.', true],
    ['*💛', 'heart: 💛', true],
    ['https://example.com/API/*', 'https://example.com/api/users', false],
    ['https://example.com/v1\\?x=1', 'https://example.com/v1?x=1', true],
    ['https://example.com/v1\\?x=1', 'https://example.com/v1Ax=1', false],
    ['a\\\\b', 'a\\b', true],
    ['a\\', 'a', true],
    ['https://a.example/*', 'https://aXexample/path', false],
    ['a*bc', 'abcbc', true],
    ['a?b', 'ab', true],
    ['?a', 'ba', true],
    ['https://example.com/*a?b', 'https://example.com/aaxb', true],
    ['*a?b', 'aaccb', false],
    ['*a??b', 'aaxxb', true],
    ['*a?b*c?d', 'aaxbccyd', true],
    ['*💛?b', '💛💛xb', true],
    ['*a?\\*', 'aax*', true],
  ];
  for (const [pattern, url, expected] of cases) {
    const matcher = compileUrlPattern(pattern);
    assert.equal(matcher.test(url), expected, JSON.stringify({ pattern, url }));
    assert.equal(matcher.test(url), expected, 'a matcher can be reused without state');
  }
});

test('small wildcard combinations agree with a bounded regex reference', () => {
  function strings(alphabet: string[], maxLength: number): string[] {
    const values = [''];
    let level = [''];
    for (let length = 1; length <= maxLength; length += 1) {
      level = level.flatMap((prefix) => alphabet.map((character) => prefix + character));
      values.push(...level);
    }
    return values;
  }
  const urls = strings(['a', 'b'], 4);
  for (const pattern of strings(['a', 'b', '*', '?'], 5)) {
    const reference = new RegExp(`^${pattern.replaceAll('*', '.*').replaceAll('?', '.?')}$`, 'u');
    const matcher = compileUrlPattern(pattern);
    for (const url of urls)
      assert.equal(matcher.test(url), reference.test(url), JSON.stringify({ pattern, url }));
  }
});

test('repeated wildcard parts do not cause exponential backtracking', { timeout: 2_000 }, () => {
  const matcher = compileUrlPattern('https://example.com/' + '*a'.repeat(32) + 'b');
  assert.equal(matcher.test('https://example.com/' + 'a'.repeat(10_000) + 'c'), false);
  assert.equal(matcher.test('https://example.com/' + 'a'.repeat(10_000) + 'b'), true);
  assert.equal(compileUrlPattern('He' + '*'.repeat(1_000) + 'o').test('Hello'), true);
});
