import test from 'node:test';
import assert from 'node:assert/strict';

import { extractContentFromHtml } from '../src/content-extract.js';
import type { NormalizedExtractContentParams } from '../../protocol/src/types.js';

const defaults: NormalizedExtractContentParams = {
  format: 'text',
  selector: null,
  includeMetadata: true,
  consistency: 'best_effort',
  textBudget: 8000,
  settleTimeoutMs: 2000,
};

test('Node semantic extraction chooses meaningful content and excludes sensitive markup', () => {
  const result = extractContentFromHtml(
    '<nav>Noise</nav><main><h1>Guide</h1><p>Useful documentation content.</p><input value="secret"><script>secret()</script></main><article>Short</article>',
    defaults,
    { title: 'Docs' }
  );

  assert.equal(result.source, 'semantic-root');
  assert.match(result.content, /Useful documentation content/);
  assert.doesNotMatch(result.content, /secret/);
  assert.equal(result.title, 'Docs');
});

test('Node semantic extraction renders bounded Markdown structure', () => {
  const result = extractContentFromHtml(
    '<main><h2>API</h2><p>Use <strong>care</strong> and <a href="/guide">read more</a>.</p><ul><li>One</li><li>Two</li></ul><pre>const x = 1;</pre><p>This deliberately long paragraph ensures omitted output.</p></main>',
    { ...defaults, format: 'markdown', selector: 'main', includeMetadata: false, textBudget: 100 }
  );

  assert.match(result.content, /## API/);
  assert.match(result.content, /\*\*care\*\*/);
  assert.match(result.content, /\[read more\]\(\/guide\)/);
  assert.equal(result.title, undefined);
  assert.equal(result.truncated, true);
  assert.ok(result.omitted > 0);
});

test('Node semantic extraction uses Readability for long articles', () => {
  const paragraphs = Array.from(
    { length: 12 },
    (_, index) =>
      `<p>Paragraph ${index} contains enough useful article prose for reader extraction.</p>`
  ).join('');
  const result = extractContentFromHtml(
    `<article><h1>Reader title</h1>${paragraphs}</article>`,
    defaults
  );

  assert.equal(result.source, 'readability');
  assert.match(result.content, /Paragraph 0/);
});

test('Node semantic extraction returns a bounded empty body fallback', () => {
  const result = extractContentFromHtml('', defaults);
  assert.equal(result.source, 'body');
  assert.equal(result.content, '');
  assert.equal(result.length, 0);
  assert.equal(result.truncated, false);
});
