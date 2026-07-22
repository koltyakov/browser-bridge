import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackgroundInputController } from '../src/background-input.js';
import { createRequest } from '../../protocol/src/index.js';

type CommandCall = { method: string; params: Record<string, unknown> };

function createController(
  options: { failMove?: boolean; failRevalidationAt?: number; staleRead?: boolean } = {}
) {
  const commands: CommandCall[] = [];
  const messages: Array<Record<string, unknown>> = [];
  let moveCount = 0;
  let revalidationCount = 0;
  const controller = createBackgroundInputController({
    contentScriptTimeoutMs: 5000,
    async runWithDebugger<T>(_tabId: number, operation: (target: { tabId: number }) => Promise<T>) {
      return operation({ tabId: 17 });
    },
    async sendCommand(_target, method, params) {
      commands.push({ method, params });
      if (
        options.failMove &&
        method === 'Input.dispatchMouseEvent' &&
        params.type === 'mouseMoved'
      ) {
        moveCount += 1;
        if (moveCount === 3) throw new Error('movement failed');
      }
      return {};
    },
    async sendTabMessage(_tabId, message) {
      messages.push(message);
      const method = message.method;
      const params = message.params as { target?: { selector?: string }; elementRef?: string };
      if (method === 'input.read_value') {
        if (options.staleRead) {
          return {
            error: {
              code: 'ELEMENT_STALE',
              message: 'Element reference is stale.',
              details: { elementRef: params.elementRef },
            },
          };
        }
        return { elementRef: params.elementRef, value: 'native value' };
      }
      if (method === 'input.revalidate_native') {
        revalidationCount += 1;
        if (revalidationCount === options.failRevalidationAt) {
          return {
            error: {
              code: 'INPUT_FOCUS_CHANGED',
              message: 'Focus moved away from the native text target.',
              details: { elementRef: params.elementRef },
            },
          };
        }
        return { elementRef: params.elementRef, active: true };
      }
      const selector = params.target?.selector ?? '';
      return {
        elementRef: selector.includes('destination') ? 'el_destination' : 'el_target',
        point: selector.includes('destination') ? { x: 100, y: 80 } : { x: 10, y: 20 },
        resolution: {
          strategy: 'selector-first',
          candidateCount: 1,
          evaluatedCount: 1,
          scrolled: false,
          hitTest: 'target',
          recovered: false,
        },
      };
    },
  });
  return { controller, commands, messages };
}

const tab = { tabId: 17, windowId: 3, title: 'Input', url: 'https://example.test' };

test('CDP click resolves immediately before native mouse dispatch', async () => {
  const { controller, commands, messages } = createController();
  const request = createRequest({
    id: 'cdp-click',
    method: 'input.click',
    params: { target: { selector: '#save' }, executionMode: 'cdp' },
  });
  const result = await controller.handleNativeInput(request, tab, request.params);
  assert.equal(messages[0].method, 'input.resolve_native');
  assert.deepEqual(
    commands.map((call) => [call.method, call.params.type]),
    [
      ['Input.dispatchMouseEvent', 'mouseMoved'],
      ['Input.dispatchMouseEvent', 'mousePressed'],
      ['Input.dispatchMouseEvent', 'mouseReleased'],
    ]
  );
  assert.deepEqual(result.execution, {
    requestedMode: 'cdp',
    actualMode: 'cdp',
    fallbackReason: null,
    debuggerUsed: true,
    targetCoordinates: { x: 10, y: 20 },
  });
});

test('CDP fill clears, inserts text once, and reads without mutation replay', async () => {
  const { controller, commands, messages } = createController();
  const request = createRequest({
    id: 'cdp-fill',
    method: 'input.fill',
    params: {
      target: { selector: '#name' },
      value: 'native value',
      mode: 'setter',
      executionMode: 'cdp',
    },
  });
  const result = await controller.handleNativeInput(request, tab, request.params);
  assert.equal(commands.filter((call) => call.method === 'Input.insertText').length, 1);
  assert.equal(messages.filter((message) => message.method === 'input.resolve_native').length, 1);
  assert.equal(messages.filter((message) => message.method === 'input.read_value').length, 1);
  assert.equal(result.value, 'native value');
  assert.equal(result.mode, 'cdp');
  assert.deepEqual(result.postMutation, { status: 'read-back', verified: true });
});

test('CDP text insertion revalidates exact focus immediately before insertText', async () => {
  const { controller, commands, messages } = createController({ failRevalidationAt: 2 });
  const request = createRequest({
    id: 'cdp-redirected-focus',
    method: 'input.type',
    params: { target: { selector: '#name' }, text: 'unsafe', executionMode: 'cdp' },
  });
  await assert.rejects(
    controller.handleNativeInput(request, tab, request.params),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code?: unknown }).code === 'INPUT_FOCUS_CHANGED'
  );
  assert.equal(
    messages.filter((message) => message.method === 'input.revalidate_native').length,
    2
  );
  assert.equal(
    commands.some((call) => call.method === 'Input.insertText'),
    false
  );
});

test('CDP text reports an unverified rerender without failing after mutation', async () => {
  const { controller, commands } = createController({ staleRead: true });
  const request = createRequest({
    id: 'cdp-rerender',
    method: 'input.type',
    params: { target: { selector: '#name' }, text: 'hello', executionMode: 'cdp' },
  });
  const result = await controller.handleNativeInput(request, tab, request.params);
  assert.equal(commands.filter((call) => call.method === 'Input.insertText').length, 1);
  assert.equal(result.elementRef, 'el_target');
  assert.equal(result.value, null);
  assert.equal(result.typed, 5);
  assert.deepEqual(result.postMutation, {
    status: 'target-rerendered',
    verified: false,
  });
});

test('CDP click uses correct button masks and emits real double-click sequences', async () => {
  for (const [button, expectedMask] of [
    ['middle', 4],
    ['right', 2],
  ] as const) {
    const { controller, commands } = createController();
    const request = createRequest({
      id: `cdp-${button}`,
      method: 'input.click',
      params: { target: { selector: '#save' }, button, executionMode: 'cdp' },
    });
    await controller.handleNativeInput(request, tab, request.params);
    const pressed = commands.find((call) => call.params.type === 'mousePressed');
    assert.equal(pressed?.params.button, button);
    assert.equal(pressed?.params.buttons, expectedMask);
  }

  const { controller, commands } = createController();
  const request = createRequest({
    id: 'cdp-double',
    method: 'input.click',
    params: { target: { selector: '#save' }, clickCount: 2, executionMode: 'cdp' },
  });
  await controller.handleNativeInput(request, tab, request.params);
  assert.deepEqual(
    commands.slice(1).map((call) => ({
      type: call.params.type,
      buttons: call.params.buttons,
      clickCount: call.params.clickCount,
    })),
    [
      { type: 'mousePressed', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', buttons: 0, clickCount: 1 },
      { type: 'mousePressed', buttons: 1, clickCount: 2 },
      { type: 'mouseReleased', buttons: 0, clickCount: 2 },
    ]
  );
});

test('CDP drag guarantees mouse release after movement failure', async () => {
  const { controller, commands } = createController({ failMove: true });
  const request = createRequest({
    id: 'cdp-drag',
    method: 'input.drag',
    params: {
      source: { selector: '#source' },
      destination: { selector: '#destination' },
      executionMode: 'cdp',
    },
  });
  await assert.rejects(
    controller.handleNativeInput(request, tab, request.params),
    /movement failed/
  );
  assert.equal(commands.at(-1)?.params.type, 'mouseReleased');
});

test('CDP drag returns explicitly resolved source and destination metadata', async () => {
  const { controller } = createController();
  const request = createRequest({
    id: 'cdp-drag-result',
    method: 'input.drag',
    params: {
      source: { selector: '#source' },
      destination: { selector: '#destination' },
      executionMode: 'cdp',
    },
  });
  const result = await controller.handleNativeInput(request, tab, request.params);
  assert.equal(result.sourceRef, 'el_target');
  assert.equal(result.destinationRef, 'el_destination');
  assert.equal(result.dragged, true);
  assert.deepEqual(result.resolution, {
    source: {
      strategy: 'selector-first',
      candidateCount: 1,
      evaluatedCount: 1,
      scrolled: false,
      hitTest: 'target',
      recovered: false,
    },
    destination: {
      strategy: 'selector-first',
      candidateCount: 1,
      evaluatedCount: 1,
      scrolled: false,
      hitTest: 'target',
      recovered: false,
    },
  });
});

test('unsupported CDP input fails before attaching or dispatching', async () => {
  const { controller, commands, messages } = createController();
  const request = createRequest({
    id: 'cdp-focus',
    method: 'input.focus',
    params: { target: { selector: '#name' }, executionMode: 'cdp' },
  });
  await assert.rejects(
    controller.handleNativeInput(request, tab, request.params),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code?: unknown }).code === 'INPUT_UNSUPPORTED'
  );
  assert.deepEqual(commands, []);
  assert.deepEqual(messages, []);
});
