import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chromeSkipReason,
  runContentCheckInChrome,
} from '../../../tests/_helpers/contentBrowser.ts';

// Each corpus entry is HTML whose first element with data-name is named.
// The expected name is what Chrome's accessibility tree computes; when Chrome
// exposes computedName (ComputedAccessibilityInfo) the check also compares
// against it directly.
async function checkAccessibleNames(): Promise<void> {
  const helpers = Reflect.get(globalThis, '__BBX_CONTENT_HELPERS__') as {
    getAccessibleName: (element: Element) => string;
  };
  const corpus: Array<[string, string]> = [
    ['<button data-name><span>S</span>ave</button>', 'Save'],
    ['<button data-name><b>Save</b> <i>draft</i></button>', 'Save draft'],
    ['<button data-name><img src="data:," alt="Close"></button>', 'Close'],
    ['<button data-name><span aria-label="Delete item"></span></button>', 'Delete item'],
    [
      '<button data-name><svg viewBox="0 0 1 1"><title>Search</title><path d="M0 0"/></svg></button>',
      'Search',
    ],
    ['<button data-name>Visible<span hidden>Hidden</span></button>', 'Visible'],
    ['<button data-name>Visible<span style="display:none">Hidden</span></button>', 'Visible'],
    ['<button data-name>Open<span aria-hidden="true">▾</span></button>', 'Open'],
    ['<a data-name href="#"><div>Line one</div><div>Line two</div></a>', 'Line one Line two'],
    ['<a data-name href="#">One<br>Two</a>', 'One Two'],
    ['<button data-name aria-label="Explicit">Content</button>', 'Explicit'],
    ['<label for="f">Email</label><input data-name id="f">', 'Email'],
    ['<label>Name <input data-name></label>', 'Name'],
    ['<button data-name title="Tip"></button>', 'Tip'],
    ['<input data-name type="submit">', 'Submit'],
    [
      '<span id="l1">First</span><span id="l2">Last</span><button data-name aria-labelledby="l1 l2">x</button>',
      'First Last',
    ],
  ];
  const failures: string[] = [];
  for (const [html, expected] of corpus) {
    document.body.innerHTML = html;
    const element = document.querySelector('[data-name]');
    if (!element) {
      failures.push(`no element: ${html}`);
      continue;
    }
    const actual = helpers.getAccessibleName(element);
    if (actual !== expected) failures.push(`${html}: got "${actual}", expected "${expected}"`);
    const computed = (element as Element & { computedName?: string }).computedName;
    if (typeof computed === 'string' && computed.replace(/\s+/g, ' ').trim() !== actual) {
      failures.push(`${html}: Chrome computes "${computed}", bridge "${actual}"`);
    }
  }
  if (failures.length) throw new Error(`FAILURES\n${failures.join('\n')}`);
}

test(
  'accessible names match Chrome on a corpus of name sources',
  { skip: chromeSkipReason, timeout: 60_000 },
  async () => {
    const result = await runContentCheckInChrome(checkAccessibleNames, {
      extraArgs: ['--enable-blink-features=ComputedAccessibilityInfo'],
    });
    assert.ok(result.passed, result.output.replace(/<[^>]+>/g, ''));
  }
);
