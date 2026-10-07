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
      if (method === 'input.observe_start') return { observationId: 'obs_1' };
      if (method === 'input.observe_finish') {
        return { changed: true, dom: { added: 1, removed: 0 }, settledMs: 12 };
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
  // Clicks observe effects by default, so observation brackets the native input.
  assert.deepEqual(
    messages.map((message) => message.method),
    ['input.observe_start', 'input.resolve_native', 'input.observe_finish']
  );
  assert.deepEqual(result.effects, { changed: true, dom: { added: 1, removed: 0 }, settledMs: 12 });
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

test('CDP click holds the button between press and release', async () => {
  const { controller, commands } = createController();
  const request = createRequest({
    id: 'cdp-hold',
    method: 'input.click',
    params: { target: { selector: '#key' }, executionMode: 'cdp', holdMs: 30 },
  });
  const pressedAt: number[] = [];
  const started = performance.now();
  const result = await controller.handleNativeInput(request, tab, request.params);
  for (const call of commands) {
    if (call.params.type === 'mousePressed' || call.params.type === 'mouseReleased') {
      pressedAt.push(call.params.type === 'mousePressed' ? 0 : 1);
    }
  }
  assert.deepEqual(pressedAt, [0, 1]);
  assert.ok(performance.now() - started >= 25);
  assert.equal(result.holdMs, 30);
});

test('CDP press_key focuses the target and sends a trusted held key pair', async () => {
  const { controller, commands, messages } = createController();
  const request = createRequest({
    id: 'cdp-key',
    method: 'input.press_key',
    params: { target: { selector: '#piano' }, key: 'q', holdMs: 20, executionMode: 'cdp' },
  });
  const started = performance.now();
  const result = await controller.handleNativeInput(request, tab, request.params);
  const resolveMessage = messages.find((message) => message.method === 'input.resolve_native');
  assert.equal(resolveMessage?.method, 'input.resolve_native');
  assert.equal((resolveMessage?.params as { kind?: unknown } | undefined)?.kind, 'focus');
  assert.deepEqual(
    commands.map((call) => [call.method, call.params.type, call.params.code]),
    [
      ['Input.dispatchKeyEvent', 'keyDown', 'KeyQ'],
      ['Input.dispatchKeyEvent', 'keyUp', 'KeyQ'],
    ]
  );
  assert.ok(performance.now() - started >= 15);
  assert.equal(result.key, 'q');
  assert.equal(result.elementRef, 'el_target');

  const pageLevel = createRequest({
    id: 'cdp-key-page',
    method: 'input.press_key',
    params: { key: 'Enter', executionMode: 'cdp' },
  });
  const pageResult = await controller.handleNativeInput(pageLevel, tab, pageLevel.params);
  assert.equal(pageResult.elementRef, null);
  assert.equal(
    messages.filter((message) => message.method === 'input.resolve_native').length,
    1,
    'page-level key presses do not resolve a target'
  );
  assert.equal((pageResult.execution as Record<string, unknown>).targetCoordinates, undefined);

  const invalid = createRequest({
    id: 'cdp-key-invalid',
    method: 'input.press_key',
    params: { key: 'NotAKey', executionMode: 'cdp' },
  });
  await assert.rejects(
    controller.handleNativeInput(invalid, tab, invalid.params),
    (error: unknown) => (error as { code?: unknown }).code === 'INVALID_REQUEST'
  );
});

test('CDP touch puts every finger down in one event, moves them, and always lifts them', async () => {
  const { controller, commands } = createController();
  const chord = createRequest({
    id: 'cdp-chord',
    method: 'input.touch',
    params: {
      points: [{ target: { selector: '#c' } }, { x: 50, y: 60 }],
      holdMs: 10,
      executionMode: 'cdp',
    },
  });
  const chordResult = await controller.handleNativeInput(chord, tab, chord.params);
  assert.deepEqual(
    commands.map((call) => [call.method, call.params.type]),
    [
      ['Input.dispatchTouchEvent', 'touchStart'],
      ['Input.dispatchTouchEvent', 'touchEnd'],
    ]
  );
  assert.deepEqual(
    (commands[0].params.touchPoints as Array<Record<string, unknown>>).map((point) => [
      point.id,
      point.x,
      point.y,
    ]),
    [
      [0, 10, 20],
      [1, 50, 60],
    ]
  );
  assert.deepEqual(commands[1].params.touchPoints, []);
  assert.equal(chordResult.pointCount, 2);
  assert.deepEqual(chordResult.points, [
    { elementRef: 'el_target', x: 10, y: 20 },
    { elementRef: null, x: 50, y: 60 },
  ]);

  commands.length = 0;
  const pinch = createRequest({
    id: 'cdp-pinch',
    method: 'input.touch',
    params: {
      points: [
        { x: 40, y: 40, to: { x: 20, y: 40 } },
        { x: 60, y: 40, to: { x: 80, y: 40 } },
      ],
      holdMs: 4,
      moveSteps: 2,
      executionMode: 'cdp',
    },
  });
  await controller.handleNativeInput(pinch, tab, pinch.params);
  assert.deepEqual(
    commands.map((call) => call.params.type),
    ['touchStart', 'touchMove', 'touchMove', 'touchEnd']
  );
  assert.deepEqual(
    (commands[2].params.touchPoints as Array<Record<string, unknown>>).map((point) => point.x),
    [20, 80]
  );
});

test('CDP touch forwards semantic locators for both gesture endpoints', async () => {
  const { controller, commands, messages } = createController();
  const start = { role: 'button', name: 'Start' };
  const end = { label: 'End' };
  const request = createRequest({
    id: 'cdp-touch-locators',
    method: 'input.touch',
    params: {
      points: [{ target: start, to: { target: end } }],
      holdMs: 0,
      moveSteps: 1,
      executionMode: 'cdp',
    },
  });
  const result = await controller.handleNativeInput(request, tab, request.params);
  assert.equal(result.touched, true);
  assert.deepEqual(
    messages
      .filter((message) => message.method === 'input.resolve_native')
      .map((message) => (message.params as Record<string, unknown>).target),
    [
      { elementRef: undefined, selector: undefined, ...start },
      { elementRef: undefined, selector: undefined, ...end },
    ]
  );
  assert.deepEqual(
    commands.map((command) => command.params.type),
    ['touchStart', 'touchMove', 'touchEnd']
  );
});

test('CDP touch lifts fingers even when a move fails', async () => {
  const commands: CommandCall[] = [];
  const controller = createBackgroundInputController({
    contentScriptTimeoutMs: 5000,
    async runWithDebugger<T>(_tabId: number, operation: (target: { tabId: number }) => Promise<T>) {
      return operation({ tabId: 17 });
    },
    async sendCommand(_target, method, params) {
      commands.push({ method, params });
      if (params.type === 'touchMove') throw new Error('move failed');
      return {};
    },
    async sendTabMessage() {
      return {};
    },
  });
  const request = createRequest({
    id: 'cdp-touch-fail',
    method: 'input.touch',
    params: { points: [{ x: 1, y: 1, to: { x: 5, y: 5 } }], holdMs: 0, executionMode: 'cdp' },
  });
  await assert.rejects(controller.handleNativeInput(request, tab, request.params), /move failed/);
  assert.deepEqual(
    commands.map((call) => call.params.type),
    ['touchStart', 'touchMove', 'touchEnd']
  );
});
