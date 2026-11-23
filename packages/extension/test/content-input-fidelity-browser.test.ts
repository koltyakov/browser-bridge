import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chromeSkipReason,
  runContentCheckInChrome,
} from '../../../tests/_helpers/contentBrowser.ts';

// Each case is a fixture for one synthetic-input fidelity bug. The check runs
// in headless Chrome against the built content scripts and reports every
// failing case at once.
async function checkInputFidelity(): Promise<void> {
  type Input = Record<
    string,
    (params: Record<string, unknown>) => Promise<Record<string, unknown>>
  >;
  const input = Reflect.get(globalThis, '__BBX_CONTENT_INPUT__') as Input;
  const failures: string[] = [];
  const equal = (actual: unknown, expected: unknown, label: string): void => {
    if (actual !== expected) throw new Error(`${label}: ${String(actual)} !== ${String(expected)}`);
  };
  const ok = (value: unknown, label: string): void => {
    if (!value) throw new Error(label);
  };
  const reset = (html: string): void => {
    document.body.innerHTML = html;
    window.scrollTo(0, 0);
    (document.activeElement as HTMLElement | null)?.blur?.();
  };
  const get = <T extends Element = HTMLElement>(id: string, root: ParentNode = document): T => {
    const element = root.querySelector(`#${id}`);
    if (!element) throw new Error(`Missing ${id}`);
    return element as T;
  };
  const errorCode = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
    } catch (error) {
      return String((error as { code?: unknown }).code);
    }
    return 'no-error';
  };
  const cases: Array<[string, () => Promise<void>]> = [
    [
      'typing reaches an input inside an open shadow root',
      async () => {
        reset('<div id="host"></div>');
        const root = get('host').attachShadow({ mode: 'open' });
        root.innerHTML = '<input id="inner">';
        const inner = get<HTMLInputElement>('inner', root);
        await input.typeIntoTarget({ target: { selector: '#inner' }, text: 'abc' });
        equal(inner.value, 'abc', 'targeted shadow typing');
        await input.pressKeyTarget({ key: 'd' });
        equal(inner.value, 'abcd', 'untargeted key into focused shadow input');
      },
    ],
    [
      'a click on a wrapper reaches the descendant under the pointer',
      async () => {
        reset(
          '<div id="card" style="width:200px"><a id="link" href="#x" style="display:block;height:40px">Open</a></div>'
        );
        let fired = 0;
        get('link').addEventListener('click', (event) => {
          fired += 1;
          event.preventDefault();
        });
        await input.clickTarget({ target: { selector: '#card' } });
        equal(fired, 1, 'inner link click handler');
      },
    ],
    [
      'contenteditable typing keeps markup and honours the caret',
      async () => {
        reset('<div id="ed" contenteditable="true"><b>bold</b> tail</div>');
        const ed = get('ed');
        ed.focus();
        const range = document.createRange();
        range.setStart(ed.querySelector('b')?.firstChild as Node, 4);
        range.collapse(true);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        await input.typeIntoTarget({ target: { selector: '#ed' }, text: 'X' });
        ok(ed.querySelector('b'), 'bold markup kept');
        equal(ed.textContent, 'boldX tail', 'insert at caret');
        await input.pressKeyTarget({ target: { selector: '#ed' }, key: 'Delete' });
        equal(ed.textContent, 'boldXtail', 'forward delete after caret');
        await input.pressKeyTarget({ target: { selector: '#ed' }, key: 'Backspace' });
        equal(ed.textContent, 'boldtail', 'backspace before caret');
      },
    ],
    [
      'a button inside a disabled fieldset is not actionable',
      async () => {
        reset('<fieldset disabled><button id="fb">Go</button></fieldset>');
        equal(
          await errorCode(() => input.clickTarget({ target: { selector: '#fb' } })),
          'ELEMENT_NOT_ACTIONABLE',
          'fieldset disabled'
        );
      },
    ],
    [
      'fill sets date, number, range and color inputs and rejects values that do not stick',
      async () => {
        reset(
          '<input id="d" type="date"><input id="n" type="number"><input id="r" type="range" min="0" max="100"><input id="c" type="color">'
        );
        await input.fillTarget({ target: { selector: '#d' }, value: '2026-03-04' });
        equal(get<HTMLInputElement>('d').value, '2026-03-04', 'ISO date');
        await input.fillTarget({ target: { selector: '#d' }, value: 'March 5, 2026' });
        equal(get<HTMLInputElement>('d').value, '2026-03-05', 'parsed date');
        equal(
          await errorCode(() => input.fillTarget({ target: { selector: '#d' }, value: 'soon' })),
          'INPUT_VALUE_REJECTED',
          'unparseable date'
        );
        await input.fillTarget({ target: { selector: '#n' }, value: '1,234' });
        equal(get<HTMLInputElement>('n').value, '1234', 'grouped number');
        equal(
          await errorCode(() => input.fillTarget({ target: { selector: '#n' }, value: 'many' })),
          'INPUT_VALUE_REJECTED',
          'non-numeric number'
        );
        equal(
          await errorCode(() => input.fillTarget({ target: { selector: '#r' }, value: '150' })),
          'INPUT_VALUE_REJECTED',
          'out-of-range value'
        );
        await input.fillTarget({ target: { selector: '#c' }, value: '#FF0000' });
        equal(get<HTMLInputElement>('c').value, '#ff0000', 'hex color');
        await input.fillTarget({ target: { selector: '#c' }, value: 'blue' });
        equal(get<HTMLInputElement>('c').value, '#0000ff', 'named color');
      },
    ],
    [
      'fill accepts masked inputs that reformat the value',
      async () => {
        reset('<input id="phone">');
        const phone = get<HTMLInputElement>('phone');
        phone.addEventListener('input', () => {
          const digits = phone.value.replace(/\D/g, '').slice(0, 10);
          phone.value =
            digits.length === 10
              ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
              : digits;
        });
        const result = await input.fillTarget({
          target: { selector: '#phone' },
          value: '5551234567',
        });
        equal(phone.value, '(555) 123-4567', 'masked value');
        equal(result.value, '(555) 123-4567', 'reported value');
      },
    ],
    [
      'Space and Enter run default actions on buttons, checkboxes, links and summaries',
      async () => {
        reset(
          '<button id="b">B</button><input id="cb" type="checkbox"><a id="a" href="#go">A</a><details id="det"><summary id="sum">S</summary>x</details>'
        );
        let clicks = 0;
        get('b').addEventListener('click', () => (clicks += 1));
        await input.pressKeyTarget({ target: { selector: '#b' }, key: ' ' });
        equal(clicks, 1, 'space activates button');
        await input.pressKeyTarget({ target: { selector: '#cb' }, key: 'Space' });
        equal(get<HTMLInputElement>('cb').checked, true, 'space toggles checkbox');
        let followed = 0;
        get('a').addEventListener('click', (event) => {
          followed += 1;
          event.preventDefault();
        });
        await input.pressKeyTarget({ target: { selector: '#a' }, key: 'Enter' });
        equal(followed, 1, 'enter follows link');
        await input.pressKeyTarget({ target: { selector: '#sum' }, key: 'Enter' });
        equal(get<HTMLDetailsElement>('det').open, true, 'enter toggles summary');
      },
    ],
    [
      'Tab moves focus and arrows change select and radio groups',
      async () => {
        reset(
          '<input id="t1"><button id="t2">x</button><input id="t3" tabindex="-1"><input id="t4">' +
            '<select id="s"><option>a</option><option disabled>b</option><option>c</option></select>' +
            '<input type="radio" name="g" id="r1" checked><input type="radio" name="g" id="r2">'
        );
        get('t1').focus();
        await input.pressKeyTarget({ key: 'Tab' });
        equal(document.activeElement?.id, 't2', 'tab forward');
        await input.pressKeyTarget({ key: 'Tab' });
        equal(document.activeElement?.id, 't4', 'tab skips tabindex -1');
        await input.pressKeyTarget({ key: 'Tab', modifiers: ['Shift'] });
        equal(document.activeElement?.id, 't2', 'shift tab');
        let changes = 0;
        get('s').addEventListener('change', () => (changes += 1));
        await input.pressKeyTarget({ target: { selector: '#s' }, key: 'ArrowDown' });
        equal(get<HTMLSelectElement>('s').selectedIndex, 2, 'arrow skips disabled option');
        equal(changes, 1, 'select change event');
        await input.pressKeyTarget({ target: { selector: '#r1' }, key: 'ArrowDown' });
        equal(get<HTMLInputElement>('r2').checked, true, 'arrow moves radio selection');
        equal(document.activeElement?.id, 'r2', 'arrow moves radio focus');
      },
    ],
    [
      'key events carry codes for shifted symbols',
      async () => {
        reset('<input id="k">');
        const seen: string[] = [];
        get('k').addEventListener('keydown', (event) =>
          seen.push(`${event.code}:${event.keyCode}`)
        );
        await input.typeIntoTarget({ target: { selector: '#k' }, text: '!A' });
        equal(seen.join(','), 'Digit1:49,KeyA:65', 'codes');
        equal(get<HTMLInputElement>('k').value, '!A', 'typed value');
      },
    ],
    [
      'Arrow keys and select-all edit text inputs',
      async () => {
        reset('<input id="e" value="abc">');
        const field = get<HTMLInputElement>('e');
        field.focus();
        field.setSelectionRange(3, 3);
        await input.pressKeyTarget({ key: 'ArrowLeft' });
        await input.typeIntoTarget({ text: 'X' });
        equal(field.value, 'abXc', 'caret moved left');
        await input.pressKeyTarget({ key: 'a', modifiers: ['Meta'] });
        await input.typeIntoTarget({ text: 'Z' });
        equal(field.value, 'Z', 'select all then replace');
      },
    ],
    [
      'mouse events carry view and screen coordinates',
      async () => {
        reset('<button id="m">M</button>');
        let view: unknown = null;
        let screenX = Number.NaN;
        get('m').addEventListener('click', (event) => {
          view = event.view;
          screenX = event.screenX;
        });
        await input.clickTarget({ target: { selector: '#m' } });
        ok(view === window, 'event.view is window');
        ok(Number.isFinite(screenX) && screenX >= event0(), 'screenX set');
        function event0(): number {
          return 0;
        }
      },
    ],
    [
      'pointer drag scrolls both ends before pressing',
      async () => {
        reset(
          '<div style="height:1000px"></div><div id="src" style="height:50px;background:red"></div>' +
            '<div style="height:350px"></div><div id="dst" style="height:50px;background:blue"></div>' +
            '<div style="height:2000px"></div>'
        );
        let down = { x: 0, y: 0 };
        let delta = Number.NaN;
        let expected = Number.NaN;
        get('src').addEventListener('pointerdown', (event) => {
          down = { x: event.clientX, y: event.clientY };
        });
        document.addEventListener('pointerup', (event) => {
          delta = event.clientY - down.y;
          expected =
            get('dst').getBoundingClientRect().top - get('src').getBoundingClientRect().top;
        });
        await input.dragTarget({ source: { selector: '#src' }, destination: { selector: '#dst' } });
        ok(
          Math.abs(delta - expected) < 30,
          `drag delta ${delta} matches layout distance ${expected}`
        );
      },
    ],
    [
      'input.type fires change once the value changed',
      async () => {
        reset('<input id="ch">');
        let changes = 0;
        get('ch').addEventListener('change', () => (changes += 1));
        await input.typeIntoTarget({ target: { selector: '#ch' }, text: 'hello' });
        equal(changes, 1, 'change after typing');
      },
    ],
    [
      'clearing uses the prototype value setter that React tracks',
      async () => {
        reset('<input id="rc" value="start">');
        const field = get<HTMLInputElement>('rc');
        const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        let tracked = 'start';
        Object.defineProperty(field, 'value', {
          configurable: true,
          get() {
            return proto?.get?.call(this);
          },
          set(next: string) {
            tracked = next;
            proto?.set?.call(this, next);
          },
        });
        await input.typeIntoTarget({ target: { selector: '#rc' }, clear: true, text: '' });
        equal(field.value, '', 'cleared');
        equal(tracked, 'start', 'instance tracker not updated');
      },
    ],
    [
      'a wrapped inline link is clickable and blockers are named',
      async () => {
        reset(
          '<p style="width:130px;font:16px/40px monospace;margin:0">xxxxxxxxx <a id="wl" href="#w">wrapped link text</a></p>' +
            '<button id="covered" style="position:absolute;left:0;top:300px;width:100px;height:40px">C</button>' +
            '<div style="position:absolute;left:0;top:290px;width:200px;height:80px;background:#eee" aria-label="Cookie banner">Accept cookies</div>'
        );
        let clicked = 0;
        get('wl').addEventListener('click', (event) => {
          clicked += 1;
          event.preventDefault();
        });
        await input.clickTarget({ target: { selector: '#wl' } });
        equal(clicked, 1, 'wrapped link clicked');
        let blocker: Record<string, unknown> | null = null;
        try {
          await input.clickTarget({ target: { selector: '#covered' } });
        } catch (error) {
          blocker =
            (error as { details?: { blocker?: Record<string, unknown> } }).details?.blocker ?? null;
        }
        equal(blocker?.name, 'Cookie banner', 'blocker name');
      },
    ],
  ];
  for (const [name, run] of cases) {
    try {
      await run();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(`FAILURES\n${failures.join('\n')}`);
}

test(
  'synthetic input matches browser behaviour on fidelity fixtures in Chrome',
  { skip: chromeSkipReason, timeout: 60_000 },
  async () => {
    const result = await runContentCheckInChrome(checkInputFidelity, {
      virtualTimeBudgetMs: 10_000,
    });
    assert.ok(result.passed, result.output.replace(/<[^>]+>/g, ''));
  }
);
