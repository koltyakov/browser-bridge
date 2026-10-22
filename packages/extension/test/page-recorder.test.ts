import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { loadExtensionModule } from '../../../tests/_helpers/extensionBuild.ts';

const { pageRecorder } =
  await loadExtensionModule<typeof import('../src/page-recorder.js')>('src/page-recorder.js');

test('emitted recorder bounds its buffer, isolates sessions, and expires without leaving listeners active', (t) => {
  const listeners = new Map<string, () => void>();
  const signals: AbortSignal[] = [];
  const addEventListener = (
    type: string,
    listener: () => void,
    options: { signal: AbortSignal }
  ) => {
    listeners.set(type, listener);
    signals.push(options.signal);
  };
  const globals: Record<string, unknown> = {
    window: { addEventListener },
    document: { addEventListener },
    location: new URL('https://example.test/start?token=hidden#secret'),
    crypto: webcrypto,
    __BBX_ACTIVITY_RECORDER__: undefined,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const started = pageRecorder('start', 'first', 1000);
  assert.equal(pageRecorder('start', 'first').epoch, started.epoch);
  assert.equal(pageRecorder('drain', 'first').events[0].url, 'https://example.test/start');
  const onError = listeners.get('error');
  assert(onError);
  for (let index = 0; index < 130; index++) onError();
  const drained = pageRecorder('drain', 'first');
  assert.equal(drained.events.length, 128);
  assert.equal(drained.dropped, 2);
  assert(drained.events.every((event) => event.type === 'page-error'));
  assert.deepEqual(pageRecorder('drain', 'first').events, []);
  assert.equal(pageRecorder('status', 'first').dropped, 0);

  const previousSignals = [...signals];
  const next = pageRecorder('start', 'second', 1000);
  assert.notEqual(next.epoch, started.epoch);
  assert(previousSignals.every((signal) => signal.aborted));
  assert.equal(pageRecorder('stop', 'first').missing, true);
  assert.equal(pageRecorder('status', 'second').active, true);
  t.mock.timers.tick(1000);
  assert.equal(pageRecorder('status', 'second').active, false);
  assert(signals.every((signal) => signal.aborted));
  assert.equal(pageRecorder('stop', 'second').active, false);
});

test('isolated activity capture never reads input values or transmits untrusted events', () => {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  class ElementFake {
    tagName = 'INPUT';
    get value(): string {
      throw new Error('Value must never be read');
    }
    matches() {
      return true;
    }
    closest() {
      return null;
    }
    getAttribute() {
      return null;
    }
  }
  const scope = vm.createContext({
    crypto: webcrypto,
    AbortController,
    Element: ElementFake,
    HTMLInputElement: ElementFake,
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLButtonElement: class {},
    MouseEvent: class {},
    location: {
      href: 'https://example.test/route?token=secret',
      origin: 'https://example.test',
      pathname: '/route',
    },
    window: {
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) =>
        listeners.set(type, handler),
    },
    Date,
    scrollX: 0,
    scrollY: 0,
    setTimeout: () => 1,
    clearTimeout: () => {},
    document: {
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) =>
        listeners.set(type, handler),
    },
  });
  const call = vm.runInContext(`(${pageRecorder.toString()})`, scope) as typeof pageRecorder;
  call('start', 'recording');
  const navigation = call('drain', 'recording').events;
  assert.equal(navigation[0].url, 'https://example.test/route');
  const input = new ElementFake();
  listeners.get('input')?.({ type: 'input', isTrusted: false, composedPath: () => [input] });
  assert.equal(call('drain', 'recording').events.length, 0);
  for (let i = 0; i < 3; i++)
    listeners.get('input')?.({ type: 'input', isTrusted: true, composedPath: () => [input] });
  const result = call('stop', 'recording');
  assert.equal(result.active, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].count, 3);
  assert.equal(result.events[0].value, '[redacted]');
  assert.equal(result.events[0].label, '');
  assert.equal(call('status', 'another').missing, true);
});
