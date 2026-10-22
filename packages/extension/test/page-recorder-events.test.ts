import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { parseHTML } from 'linkedom';
import { loadExtensionModule } from '../../../tests/_helpers/extensionBuild.ts';

const { pageRecorder } =
  await loadExtensionModule<typeof import('../src/page-recorder.js')>('src/page-recorder.js');

function recorderPage(t: TestContext, body: string) {
  const window = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  const { document, Event } = window;
  class RecordedMouseEvent extends Event {
    clientX = 12.6;
    clientY = 40.2;
  }
  const location = new URL('https://example.test/form?token=never-record#private');
  const globals: Record<string, unknown> = {
    window,
    document,
    location,
    Element: window.Element,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLButtonElement: window.HTMLButtonElement,
    MouseEvent: RecordedMouseEvent,
    scrollX: 15.6,
    scrollY: 100.2,
    __BBX_ACTIVITY_RECORDER__: undefined,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  t.after(() => {
    pageRecorder('stop', 'test-recording');
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const element = (selector: string): Element => {
    const found = document.querySelector(selector);
    assert(found, `Fixture contains ${selector}`);
    return found;
  };
  const emit = (selector: string, type: string, trusted = true) => {
    const event =
      type === 'click'
        ? new RecordedMouseEvent(type, { bubbles: true })
        : new Event(type, { bubbles: true });
    // Linkedom has no browser input pipeline. Mark only events supplied by this fixture trusted.
    Object.defineProperty(event, 'isTrusted', { value: trusted });
    element(selector).dispatchEvent(event);
  };
  const drain = () => pageRecorder('drain', 'test-recording').events;
  pageRecorder('start', 'test-recording', 60000);
  assert.equal(drain()[0].url, 'https://example.test/form');
  return { document, window, location, element, emit, drain };
}

test('recorder groups typing by field and idle time, preserving event-time labels and action order', (t) => {
  const page = recorderPage(
    t,
    `
    <label id="search-label" for="search">Search products</label><input id="search">
    <textarea id="notes" aria-label="Notes"></textarea>
    <button id="save"><span>Save changes</span></button>
  `
  );
  const search = page.element('#search');
  // Linkedom does not implement the browser's labels collection.
  Object.defineProperty(search, 'labels', { value: [page.element('#search-label')] });
  Object.defineProperty(search, 'value', {
    get: () => {
      throw new Error('Input values must never be read');
    },
  });
  for (let index = 0; index < 3; index++) page.emit('#search', 'input');
  page.element('#search-label').textContent = 'Changed after input';
  t.mock.timers.tick(399);
  page.emit('#notes', 'input');
  page.emit('#save span', 'click');
  const events = page.drain();
  assert.deepEqual(
    events.map((event) => event.type),
    ['input', 'input', 'click']
  );
  assert.equal(events[0].count, 3);
  assert.equal(events[0].at, 10000);
  assert.equal(events[0].label, 'Search products');
  assert.equal(events[0].value, '[redacted]');
  assert.deepEqual(events[0].target, { selector: '[id="search"]' });
  assert.equal(events[1].count, 1);
  assert.equal(events[1].label, 'Notes');
  assert.equal(events[2].label, 'Save changes');
  assert.equal(events[2].role, 'button');
  assert.deepEqual(events[2].target, { selector: '[id="save"]' });
  assert.equal(events[2].x, 13);
  assert.equal(events[2].y, 40);
  assert(events.every((event) => event.origin === 'trusted-event'));

  page.emit('#notes', 'input');
  t.mock.timers.tick(400);
  page.emit('#notes', 'input');
  t.mock.timers.tick(400);
  const idleGroups = page.drain();
  assert.deepEqual(
    idleGroups.map((event) => event.count),
    [1, 1]
  );
  assert.equal(Number(idleGroups[1].at) - Number(idleGroups[0].at), 400);
  assert.deepEqual(page.drain(), []);
});

test('recorder redacts private controls and credential-like labels without reading values or link destinations', (t) => {
  const page = recorderPage(
    t,
    `
    <input id="password" type="password" aria-label="password-label-secret">
    <div data-private><input id="private" aria-label="private-label-secret"></div>
    <div data-sensitive><button id="sensitive">sensitive-label-secret</button></div>
    <div autocomplete="current-password"><textarea id="autocomplete" aria-label="autocomplete-label-secret"></textarea></div>
    <div contenteditable="true"><span id="editable">editable-label-secret</span></div>
    <button id="public">Contact person@example.test Bearer confidential token=secret-value key=key-value</button>
    <a id="link" href="https://example.test/?secret=href-value" aria-label="Continue">Link text</a>
  `
  );
  for (const selector of ['#password', '#private', '#autocomplete']) {
    Object.defineProperty(page.element(selector), 'value', {
      get: () => {
        throw new Error('Private values must never be read');
      },
    });
    page.emit(selector, 'input');
  }
  page.emit('#sensitive', 'click');
  page.emit('#editable', 'input');
  page.emit('#public', 'click');
  Object.defineProperty(page.element('#link'), 'href', {
    get: () => {
      throw new Error('Link destinations must never be read');
    },
  });
  page.emit('#link', 'click');
  const events = page.drain();
  assert.equal(events.length, 7);
  for (const event of events.slice(0, 5)) {
    assert.equal(event.label, '');
    assert.equal(event.target, undefined);
    if (event.type === 'input') assert.equal(event.value, '[redacted]');
  }
  assert.equal(events[5].label, 'Contact [redacted] [redacted] [redacted] [redacted]');
  assert.equal(events[6].label, 'Continue');
  assert.doesNotMatch(
    JSON.stringify(events),
    /label-secret|person@example|confidential|secret-value|key-value|href-value/
  );
});

test('recorder generates unique bounded locators and avoids embedding credential-bearing IDs', (t) => {
  const nested = `<section>${'<div>'.repeat(6)}<button>Deep button</button>${'</div>'.repeat(6)}</section>`;
  const page = recorderPage(
    t,
    `
    <button id="duplicate" data-testid="first-action">First</button>
    <button id="duplicate" data-testid="second-action">Second</button>
    <button id="token-value" data-testid="safe-action">Safe</button>
    <button id="unsafe&quot;value">Positional</button>
    <select id="choice"><option>Choice</option></select>
    <div id="custom" role="${'r'.repeat(50)}" aria-label="${'a'.repeat(180)}"></div>
    ${nested}${nested}
  `
  );
  page.emit('[data-testid="second-action"]', 'click');
  page.emit('[data-testid="safe-action"]', 'click');
  page.emit('body > button:nth-of-type(4)', 'click');
  page.emit('#choice', 'change');
  page.emit('#custom', 'submit');
  page.emit('section:first-of-type button', 'click');
  const events = page.drain();
  assert.deepEqual(events[0].target, { selector: '[data-testid="second-action"]' });
  assert.deepEqual(events[1].target, { selector: '[data-testid="safe-action"]' });
  const positional = events[2].target as { selector: string };
  assert.equal(page.document.querySelectorAll(positional.selector).length, 1);
  assert.equal(
    page.document.querySelector(positional.selector),
    page.element('body > button:nth-of-type(4)')
  );
  assert(!positional.selector.includes('unsafe'));
  assert.equal(events[3].role, 'select');
  assert.equal(events[3].label, '');
  assert.equal(String(events[4].label).length, 160);
  assert.equal(String(events[4].role).length, 40);
  assert.equal(events[5].target, undefined, 'ambiguous locators beyond six ancestors are omitted');
});

test('recorder throttles scrolls, observes route changes on drain, and ignores synthetic or stopped input', (t) => {
  const page = recorderPage(t, '<main id="main"><button id="save">Save</button></main>');
  page.emit('#save', 'click', false);
  const documentEvent = new page.window.Event('click');
  Object.defineProperty(documentEvent, 'isTrusted', { value: true });
  page.document.dispatchEvent(documentEvent);
  assert.deepEqual(page.drain(), []);
  page.emit('#main', 'scroll');
  t.mock.timers.tick(499);
  page.emit('#main', 'scroll');
  t.mock.timers.tick(1);
  page.emit('#main', 'scroll');
  const scrolls = page.drain();
  assert.equal(scrolls.length, 2);
  assert(scrolls.every((event) => event.type === 'scroll' && event.x === 16 && event.y === 100));
  assert.equal(Number(scrolls[1].at) - Number(scrolls[0].at), 500);

  page.location.href = 'https://example.test/checkout?password=hidden#access-token';
  assert.deepEqual(
    page.drain().map((event) => event.url),
    ['https://example.test/checkout']
  );
  assert.deepEqual(page.drain(), []);
  page.location.href = 'https://example.test/done?token=hidden';
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(page.drain()[0].url, 'https://example.test/done');
  const stopped = pageRecorder('stop', 'test-recording');
  assert.equal(stopped.active, false);
  page.emit('#save', 'click');
  page.window.dispatchEvent(new page.window.Event('error'));
  page.location.pathname = '/after-stop';
  assert.deepEqual(page.drain(), []);
});
