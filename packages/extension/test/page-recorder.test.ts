import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { pageRecorder } from '../src/page-recorder.js';

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
