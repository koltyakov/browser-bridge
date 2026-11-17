import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackgroundInputController } from '../src/background-input.js';
import { executeInputPerform } from '../src/background-perform.js';
import {
  createRequest,
  createFailure,
  createSuccess,
  BridgeError,
} from '../../../protocol/src/index.js';

type CommandCall = { method: string; params: Record<string, unknown> };

function createController(
  options: {
    failMove?: boolean;
    failRevalidationAt?: number;
    staleRead?: boolean;
    active?: boolean;
    activeChecks?: boolean[];
    deactivateAfterKeyDown?: boolean;
    clearReadback?: Record<string, unknown>;
    clearReadFails?: boolean;
    observationStartFails?: boolean;
    observationFinishFails?: boolean;
    observationExpired?: boolean;
    observationNavigation?: boolean;
    legacyObservation?: boolean;
    failCommandGuard?: boolean;
    runWithDebugger?: <T>(operation: (target: { tabId: number }) => Promise<T>) => Promise<T>;
    finishObservation?: () => Promise<Record<string, unknown>>;
  } = {}
) {
  const commands: CommandCall[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  let moveCount = 0;
  let revalidationCount = 0;
  let active = options.active ?? true;
  let tabChecks = 0;
  let attachments = 0;
  let cleared = false;
  let inserted = false;
  const controller = createBackgroundInputController({
    getTab: async () => {
      const current = options.activeChecks?.[tabChecks] ?? active;
      tabChecks += 1;
      return { active: current };
    },
    contentScriptTimeoutMs: 5000,
    assertCommandActive: () => {
      if (options.failCommandGuard)
        throw new BridgeError('DIALOG_BLOCKED', 'Guard rejected before dispatch.');
    },
    async runWithDebugger<T>(_tabId: number, operation: (target: { tabId: number }) => Promise<T>) {
      attachments += 1;
      return options.runWithDebugger
        ? options.runWithDebugger(operation)
        : operation({ tabId: 17 });
    },
    async sendCommand(_target, method, params) {
      commands.push({ method, params });
      events.push(method);
      if (
        method === 'Input.dispatchKeyEvent' &&
        params.type === 'keyDown' &&
        options.deactivateAfterKeyDown
      )
        active = false;
      if (
        method === 'Input.dispatchKeyEvent' &&
        params.type === 'keyUp' &&
        params.code === 'Backspace'
      )
        cleared = true;
      if (method === 'Input.insertText') inserted = true;
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
      events.push(String(method));
      const params = message.params as { target?: { selector?: string }; elementRef?: string };
      if (method === 'input.read_value') {
        if (cleared && !inserted && options.clearReadFails)
          throw new BridgeError('TIMEOUT', 'Clear read-back was lost.');
        if (options.staleRead) {
          return {
            error: {
              code: 'ELEMENT_STALE',
              message: 'Element reference is stale.',
              details: { elementRef: params.elementRef },
            },
          };
        }
        return {
          elementRef: params.elementRef,
          value: cleared && !inserted ? '' : 'native value',
          ...(cleared && !inserted ? options.clearReadback : {}),
        };
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
      if (method === 'input.observe_start') {
        if (options.observationStartFails) throw new Error('private observation failure');
        return { observationId: 'obs_1' };
      }
      if (method === 'input.observe_finish') {
        if (options.finishObservation) return options.finishObservation();
        if (options.observationFinishFails && !(message.params as Record<string, unknown>).discard)
          throw new Error('private observation failure');
        if (options.legacyObservation) return { changed: false, navigation: 'unloading' };
        if (options.observationExpired)
          return { expired: true, observation: { status: 'unavailable', reason: 'expired' } };
        return {
          changed: true,
          dom: { added: 1, removed: 0 },
          settledMs: 12,
          ...(options.observationNavigation ? { navigation: 'unloading' } : {}),
          observation: options.observationNavigation
            ? { status: 'interrupted', reason: 'navigation' }
            : { status: 'completed' },
        };
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
  return { controller, commands, messages, events, attachments: () => attachments };
}

const tab = { tabId: 17, windowId: 3, title: 'Input', url: 'https://example.test' };

test('native pointer input rejects inactive tabs before dispatch instead of claiming a click', async () => {
  const { controller, commands, messages } = createController({ active: false });
  const request = createRequest({
    id: 'inactive-click',
    method: 'input.click',
    params: { target: { selector: '#save' }, executionMode: 'cdp' },
  });
  await assert.rejects(
    controller.handleNativeInput(request, tab, request.params),
    (error: unknown) => {
      assert(error instanceof BridgeError);
      assert.equal(error.code, 'INPUT_UNSUPPORTED');
      const details = error.details as {
        reason: string;
        tabId: number;
        aftermath: { dispatch: string };
      };
      assert.equal(details.reason, 'inactive_native_pointer_target');
      assert.equal(details.tabId, 17);
      assert.equal(details.aftermath.dispatch, 'not_started');
      return true;
    }
  );
  assert.deepEqual(commands, []);
  assert.deepEqual(messages, []);
});

test('inactive tabs reject key-dependent native flows before attachment, focus, or insertion', async () => {
  for (const [method, params] of [
    ['input.fill', { target: { selector: '#name' }, value: 'replacement' }],
    ['input.fill', { target: { selector: '#name' }, value: '' }],
    ['input.press_key', { target: { selector: '#save' }, key: 'Enter' }],
    ['input.press_key', { key: 'Escape' }],
    ['input.type', { target: { selector: '#name' }, text: 'replacement', clear: true }],
    ['input.type', { target: { selector: '#name' }, text: 'append', submit: true }],
  ] as const) {
    const harness = createController({ active: false });
    const request = createRequest({
      id: crypto.randomUUID(),
      method,
      params: { ...params, executionMode: 'cdp' },
    });
    await assert.rejects(
      harness.controller.handleNativeInput(request, tab, request.params),
      (error: unknown) => {
        assert(error instanceof BridgeError);
        assert.equal(error.code, 'INPUT_UNSUPPORTED');
        const details = error.details as {
          reason: string;
          aftermath: { dispatch: string };
          outcomeUncertain?: boolean;
        };
        assert.equal(details.reason, 'inactive_native_keyboard_target');
        assert.equal(details.aftermath.dispatch, 'not_started');
        assert.equal(details.outcomeUncertain, undefined);
        assert.equal(
          createFailure(request.id, error.code, error.message, error.details, { method }).error
            .recovery?.retry,
          false
        );
        return true;
      }
    );
    assert.equal(harness.attachments(), 0);
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.commands, []);
  }
});

test('background native text insertion without clearing or submit remains supported', async () => {
  const { controller, commands } = createController({ active: false });
  const request = createRequest({
    id: 'background-insert',
    method: 'input.type',
    params: {
      target: { selector: '#name' },
      text: 'append',
      clear: false,
      submit: false,
      executionMode: 'cdp',
    },
  });
  const result = await controller.handleNativeInput(request, tab, request.params);
  assert.deepEqual(
    commands.map((call) => call.method),
    ['Input.insertText']
  );
  assert.equal((result.aftermath as { dispatch: string }).dispatch, 'completed');
});

test('tab activity is rechecked before fresh keyboard dispatch, but never blocks a release', async () => {
  for (const options of [{ activeChecks: [true, false] }, { deactivateAfterKeyDown: true }]) {
    const { controller, commands } = createController(options);
    const request = createRequest({
      id: crypto.randomUUID(),
      method: 'input.press_key',
      params: { key: 'Enter', executionMode: 'cdp' },
    });
    if ('activeChecks' in options) {
      await assert.rejects(
        controller.handleNativeInput(request, tab, request.params),
        (error: unknown) => {
          assert(error instanceof BridgeError);
          assert.equal(
            (error.details as { aftermath: { dispatch: string } }).aftermath.dispatch,
            'not_started'
          );
          return true;
        }
      );
      assert.deepEqual(commands, []);
    } else {
      await controller.handleNativeInput(request, tab, request.params);
      assert.deepEqual(
        commands.map((call) => call.params.type),
        ['keyDown', 'keyUp']
      );
    }
  }
});

test('losing tab activity after select-all stops clearing without replay or insertion', async () => {
  const { controller, commands } = createController({ activeChecks: [true, true, false] });
  const request = createRequest({
    id: 'tab-lost-mid-clear',
    method: 'input.fill',
    params: { target: { selector: '#name' }, value: 'replacement' },
  });
  await assert.rejects(
    controller.handleNativeInput(request, tab, request.params),
    (error: unknown) => {
      assert(error instanceof BridgeError);
      assert.equal(
        (error.details as { aftermath: { dispatch: string } }).aftermath.dispatch,
        'uncertain'
      );
      assert.equal(
        createFailure(request.id, error.code, error.message, error.details, {
          method: request.method,
        }).error.recovery?.retry,
        false
      );
      return true;
    }
  );
  assert.deepEqual(
    commands.map((call) => [call.params.type, call.params.code]),
    [
      ['keyDown', 'KeyA'],
      ['keyUp', 'KeyA'],
    ]
  );
});

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
  assert.deepEqual(result.aftermath, {
    dispatch: 'completed',
    observation: { status: 'completed' },
    verification: 'not_requested',
  });
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

test('CDP observation failures do not fabricate navigation or fail acknowledged input', async () => {
  for (const [options, observation] of [
    [{ observationFinishFails: true }, { status: 'failed', reason: 'finish_failed' }],
    [{ observationStartFails: true }, { status: 'unavailable', reason: 'start_failed' }],
    [{ observationExpired: true }, { status: 'unavailable', reason: 'expired' }],
    [{ legacyObservation: true }, { status: 'unavailable', reason: 'unsupported' }],
  ] as const) {
    const { controller, commands, messages } = createController(options);
    const request = createRequest({
      id: crypto.randomUUID(),
      method: 'input.click',
      params: { target: { selector: '#save' }, executionMode: 'cdp' },
    });
    const result = await controller.handleNativeInput(request, tab, request.params);
    assert.deepEqual(result.aftermath, {
      dispatch: 'completed',
      observation,
      verification: 'not_requested',
    });
    assert.equal((result.effects as Record<string, unknown> | undefined)?.navigation, undefined);
    assert.equal((result.effects as Record<string, unknown> | undefined)?.changed, undefined);
    assert.equal(commands.filter((call) => call.params.type === 'mousePressed').length, 1);
    assert.equal(commands.filter((call) => call.params.type === 'mouseReleased').length, 1);
    assert.doesNotMatch(JSON.stringify(result), /private observation failure/);
    if ('observationFinishFails' in options) {
      assert.equal(
        messages.filter((message) => message.method === 'input.observe_finish').length,
        2
      );
      assert.equal((messages.at(-1)?.params as Record<string, unknown> | undefined)?.discard, true);
    }
  }
});

for (const sequence of [false, true]) {
  test(`a guard interrupting CDP observation preserves acknowledged ${sequence ? 'sequence step' : 'input'}`, async () => {
    let rejectGuard: (error: Error) => void = () => {};
    const blocked = new Promise<never>((_resolve, reject) => {
      rejectGuard = reject;
    });
    let signalFinishing = () => {};
    const finishing = new Promise<void>((resolve) => {
      signalFinishing = resolve;
    });
    let finishObservation: (value: Record<string, unknown>) => void = () => {};
    const observation = new Promise<Record<string, unknown>>((resolve) => {
      finishObservation = resolve;
    });
    const pending: { task: Promise<unknown> | null } = { task: null };
    const { controller, commands } = createController({
      runWithDebugger: async <T>(operation: (target: { tabId: number }) => Promise<T>) => {
        const task = operation({ tabId: 17 });
        pending.task = task;
        return Promise.race([task, blocked]);
      },
      finishObservation: () => {
        signalFinishing();
        return observation;
      },
    });
    const params = { target: { selector: '#save' }, executionMode: 'cdp', observe: true };
    const click = createRequest({ id: 'acknowledged-click', method: 'input.click', params });
    const responsePromise = sequence
      ? executeInputPerform(
          createRequest({
            id: 'acknowledged-sequence',
            method: 'input.perform',
            params: { returnLastResult: true, steps: [{ method: 'input.click', params }] },
          }),
          {
            resolveRequestTarget: async () => tab,
            dispatch: async (step) =>
              createSuccess(step.id, await controller.handleNativeInput(step, tab, step.params)),
          }
        )
      : controller
          .handleNativeInput(click, tab, click.params)
          .then((result) => createSuccess(click.id, result));
    await finishing;
    rejectGuard(
      new BridgeError('DIALOG_BLOCKED', 'private dialog text', {
        tabId: 17,
        dialogId: 'dialog_1',
        type: 'alert',
        actionStarted: true,
      })
    );
    try {
      const response = await responsePromise;
      assert.equal(response.ok, true);
      const outer = response.result as Record<string, unknown>;
      const result = sequence
        ? (outer.lastResult as { result: Record<string, unknown> }).result
        : outer;
      if (sequence) {
        assert.equal(outer.completed, 1);
        assert.deepEqual(outer.failures, []);
        assert.equal(outer.verified, undefined);
      }
      assert.equal(result.clicked, true);
      assert.deepEqual(result.aftermath, {
        dispatch: 'completed',
        verification: 'not_requested',
        observation: {
          status: 'interrupted',
          reason: 'action_interrupted',
          interruption: { code: 'DIALOG_BLOCKED', dialogId: 'dialog_1' },
        },
      });
      assert.equal(result.effects, undefined);
      assert.equal(commands.filter((call) => call.params.type === 'mousePressed').length, 1);
      assert.equal(commands.filter((call) => call.params.type === 'mouseReleased').length, 1);
      const snapshot = JSON.stringify(response);
      assert.doesNotMatch(snapshot, /private dialog text/);
      finishObservation({ changed: true, observation: { status: 'completed' } });
      await pending.task;
      assert.equal(
        JSON.stringify(response),
        snapshot,
        'Late observation must not rewrite delivered evidence.'
      );
    } finally {
      finishObservation({ observation: { status: 'failed', reason: 'finish_failed' } });
      await pending.task;
    }
  });
}

test('a native command failure preserves unavailable observation after failed startup', async () => {
  const { controller } = createController({ observationStartFails: true, failMove: true });
  const request = createRequest({
    id: 'unobserved-native-failure',
    method: 'input.drag',
    params: {
      source: { selector: '#source' },
      destination: { selector: '#destination' },
      executionMode: 'cdp',
      observe: true,
    },
  });
  await assert.rejects(
    controller.handleNativeInput(request, tab, request.params),
    (error: unknown) => {
      assert(error instanceof BridgeError);
      assert.deepEqual((error.details as Record<string, unknown>).aftermath, {
        dispatch: 'uncertain',
        observation: { status: 'unavailable', reason: 'start_failed' },
        verification: 'not_requested',
      });
      assert.equal(
        createFailure(request.id, error.code, error.message, error.details, {
          method: request.method,
        }).error.recovery?.retry,
        false
      );
      return true;
    }
  );
});

test('CDP retains confirmed observation effects without promoting them to postconditions', async () => {
  const { controller } = createController({ observationNavigation: true });
  const request = createRequest({
    id: 'confirmed-navigation',
    method: 'input.click',
    params: { target: { selector: '#save' }, executionMode: 'cdp' },
  });
  const result = await controller.handleNativeInput(request, tab, request.params);
  assert.equal((result.effects as Record<string, unknown>).navigation, 'unloading');
  assert.deepEqual(result.aftermath, {
    dispatch: 'completed',
    observation: { status: 'interrupted', reason: 'navigation' },
    verification: 'not_requested',
  });
  assert.equal(result.verified, undefined);
});

test('a pre-send debugger guard does not claim dispatch, while partial input cannot invite retry', async () => {
  const guarded = createController({ failCommandGuard: true });
  const click = createRequest({
    id: 'pre-send-guard',
    method: 'input.click',
    params: { target: { selector: '#save' }, executionMode: 'cdp' },
  });
  await assert.rejects(
    guarded.controller.handleNativeInput(click, tab, click.params),
    (error: unknown) => {
      assert(error instanceof BridgeError);
      assert.equal(
        (error.details as { aftermath: { dispatch: string } }).aftermath.dispatch,
        'not_started'
      );
      return true;
    }
  );
  assert.deepEqual(guarded.commands, []);
  const partial = createController({ failMove: true });
  const drag = createRequest({
    id: 'partial-drag',
    method: 'input.drag',
    params: {
      source: { selector: '#source' },
      destination: { selector: '#destination' },
      executionMode: 'cdp',
      observe: true,
    },
  });
  await assert.rejects(
    partial.controller.handleNativeInput(drag, tab, drag.params),
    (error: unknown) => {
      assert(error instanceof BridgeError);
      const details = error.details as {
        aftermath: { dispatch: string };
        outcomeUncertain: boolean;
      };
      assert.equal(details.aftermath.dispatch, 'uncertain');
      assert.equal(details.outcomeUncertain, true);
      const failure = createFailure(drag.id, error.code, error.message, error.details, {
        method: drag.method,
      });
      assert.equal(failure.error.recovery?.retry, false);
      assert.match(failure.error.recovery?.hint ?? '', /do not replay/);
      return true;
    }
  );
  assert.equal(partial.commands.at(-1)?.params.type, 'mouseReleased');
  assert.equal(
    (partial.messages.at(-1)?.params as Record<string, unknown> | undefined)?.discard,
    true
  );
});

test('CDP fill clears, inserts text once, and reads without mutation replay', async () => {
  const { controller, commands, messages, events } = createController();
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
  assert.equal(messages.filter((message) => message.method === 'input.read_value').length, 2);
  assert(events.indexOf('input.read_value') < events.indexOf('Input.insertText'));
  assert.equal(result.value, 'native value');
  assert.equal(result.mode, 'cdp');
  assert.deepEqual(result.postMutation, { status: 'read-back', verified: true });
  assert.equal((result.aftermath as { verification: string }).verification, 'not_requested');
});

test('native empty replacement confirms clearing without inserting text', async () => {
  for (const [method, params] of [
    ['input.fill', { value: '' }],
    ['input.type', { text: '', clear: true, submit: true }],
  ] as const) {
    const { controller, commands, messages } = createController();
    const request = createRequest({
      id: crypto.randomUUID(),
      method,
      params: { target: { selector: '#name' }, ...params },
    });
    const result = await controller.handleNativeInput(request, tab, request.params);
    assert.equal(result.value, '');
    assert.deepEqual(result.postMutation, { status: 'read-back', verified: true });
    assert.equal(
      commands.some((call) => call.method === 'Input.insertText'),
      false
    );
    assert.equal(
      commands.filter((call) => call.params.code === 'Enter').length,
      method === 'input.type' ? 2 : 0
    );
    assert.equal(messages.filter((message) => message.method === 'input.read_value').length, 2);
  }
});

test('native replacement requires an exact empty read-back and never inserts or submits on mismatch', async () => {
  for (const [method, extra] of [
    ['input.fill', { value: 'replacement' }],
    ['input.fill', { value: '' }],
    ['input.type', { text: 'replacement', clear: true, submit: true }],
  ] as const) {
    for (const readback of [
      { value: 'PRIVATE EXISTING VALUE' },
      { value: null },
      { value: undefined },
      { elementRef: 'different-target', value: '' },
    ]) {
      const { controller, commands, messages } = createController({ clearReadback: readback });
      const request = createRequest({
        id: crypto.randomUUID(),
        method,
        params: { target: { selector: '#name' }, executionMode: 'cdp', observe: true, ...extra },
      });
      await assert.rejects(
        controller.handleNativeInput(request, tab, request.params),
        (error: unknown) => {
          assert(error instanceof BridgeError);
          assert.equal(error.code, 'INPUT_UNSUPPORTED');
          const details = error.details as {
            reason: string;
            aftermath: { dispatch: string };
            outcomeUncertain: boolean;
          };
          assert.equal(details.reason, 'native_clear_not_confirmed');
          assert.equal(details.aftermath.dispatch, 'uncertain');
          assert.equal(details.outcomeUncertain, true);
          assert.equal(
            createFailure(request.id, error.code, error.message, error.details, { method }).error
              .recovery?.retry,
            false
          );
          assert.doesNotMatch(JSON.stringify(error.details), /PRIVATE EXISTING VALUE/);
          return true;
        }
      );
      assert.equal(commands.length, 4, 'Only one clear key sequence is attempted.');
      assert.equal(
        commands.some((call) => call.method === 'Input.insertText' || call.params.code === 'Enter'),
        false
      );
      assert.equal(messages.filter((message) => message.method === 'input.read_value').length, 1);
      assert.equal((messages.at(-1)?.params as Record<string, unknown> | undefined)?.discard, true);
    }
  }
});

test('lost clear read-back stops insertion with nonretryable uncertainty', async () => {
  const { controller, commands } = createController({ clearReadFails: true });
  const request = createRequest({
    id: 'lost-clear-read',
    method: 'input.fill',
    params: { target: { selector: '#name' }, value: 'replacement' },
  });
  await assert.rejects(
    controller.handleNativeInput(request, tab, request.params),
    (error: unknown) => {
      assert(error instanceof BridgeError);
      assert.equal(error.code, 'TIMEOUT');
      assert.equal(
        (error.details as { aftermath: { dispatch: string } }).aftermath.dispatch,
        'uncertain'
      );
      assert.equal(
        createFailure(request.id, error.code, error.message, error.details, {
          method: request.method,
        }).error.recovery?.retry,
        false
      );
      return true;
    }
  );
  assert.equal(commands.filter((call) => call.method === 'Input.insertText').length, 0);
});

test('a stale target during clear read-back skips replacement without replay', async () => {
  const { controller, commands } = createController({ staleRead: true });
  const request = createRequest({
    id: 'stale-clear-read',
    method: 'input.fill',
    params: { target: { selector: '#name' }, value: 'replacement' },
  });
  const result = await controller.handleNativeInput(request, tab, request.params);
  assert.equal(commands.filter((call) => call.method === 'Input.insertText').length, 0);
  assert.equal(result.value, null);
  assert.deepEqual(result.postMutation, { status: 'target-rerendered', verified: false });
});

test('CDP text insertion revalidates exact focus immediately before insertText', async () => {
  const { controller, commands, messages } = createController({ failRevalidationAt: 1 });
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
    1
  );
  assert.equal(
    commands.some((call) => call.method === 'Input.insertText'),
    false
  );
});

test('CDP append validates once, while clearing retains checks before clear and insertion', async () => {
  for (const clear of [false, true]) {
    const { controller, commands, messages } = createController();
    const request = createRequest({
      id: `cdp-append-${clear}`,
      method: 'input.type',
      params: { target: { selector: '#name' }, text: 'hello', clear, executionMode: 'cdp' },
    });
    await controller.handleNativeInput(request, tab, request.params);
    assert.equal(
      messages.filter((message) => message.method === 'input.revalidate_native').length,
      clear ? 2 : 1
    );
    assert.equal(commands.filter((call) => call.method === 'Input.insertText').length, 1);
  }
});

test('CDP clear does not insert into redirected focus after the clear', async () => {
  const { controller, commands, messages } = createController({ failRevalidationAt: 2 });
  const request = createRequest({
    id: 'cdp-focus-after-clear',
    method: 'input.fill',
    params: { target: { selector: '#name' }, value: 'unsafe', executionMode: 'cdp' },
  });
  const result = await controller.handleNativeInput(request, tab, request.params);
  assert.equal(commands.filter((call) => call.method === 'Input.insertText').length, 0);
  assert.equal(messages.filter((message) => message.method === 'input.read_value').length, 1);
  assert.equal(result.value, null);
  assert.deepEqual(result.postMutation, { status: 'focus-changed', verified: false });
});

test('failed observed CDP input discards its observation without settling or replaying', async () => {
  const { controller, commands, messages } = createController({ failRevalidationAt: 1 });
  const request = createRequest({
    id: 'cdp-observation-failure',
    method: 'input.type',
    params: {
      target: { selector: '#name' },
      text: 'unsafe',
      executionMode: 'cdp',
      observe: { settleMs: 5000 },
    },
  });
  await assert.rejects(controller.handleNativeInput(request, tab, request.params), {
    code: 'INPUT_FOCUS_CHANGED',
  });
  assert.deepEqual(
    messages.map((message) => message.method),
    [
      'input.observe_start',
      'input.resolve_native',
      'input.revalidate_native',
      'input.observe_finish',
    ]
  );
  assert.deepEqual(messages.at(-1)?.params, {
    observationId: 'obs_1',
    settleMs: 0,
    elementRef: null,
    discard: true,
  });
  assert.deepEqual(commands, []);
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
    getTab: async () => ({ active: true }),
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
