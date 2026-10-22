import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmulationController } from '../src/background-emulation.js';
import { normalizeRequestParams } from '../../../protocol/src/index.js';

function harness() {
  const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  let failure = '';
  let owners = 0;
  const controller = createEmulationController({
    acquire: async () => {
      owners++;
    },
    release: async () => {
      owners--;
    },
    send: async (_tab, method, params) => {
      commands.push({ method, params });
      if (method === failure) throw new Error('command failed');
      return {};
    },
  });
  return {
    controller,
    commands,
    fail: (method: string) => {
      failure = method;
    },
    owners: () => owners,
  };
}

test('emulation validates before dispatch and normalization is idempotent', () => {
  const config = normalizeRequestParams('emulation.apply', {
    device: 'phone',
    network: 'slow-3g',
    locale: 'fr-FR',
  });
  assert.deepEqual(normalizeRequestParams('emulation.apply', config), config);
  for (const bad of [
    {},
    { device: 'toString' },
    { network: 'bad' },
    { device: { width: Infinity, height: 10 } },
    { network: { downloadKbps: -0.5 } },
    { cpuRate: 0 },
    { locale: '!!' },
    { timezoneId: 'Nowhere' },
    { geolocation: { latitude: 91, longitude: 0 } },
    { unknown: true },
  ]) {
    assert.throws(() => normalizeRequestParams('emulation.apply', bad));
  }
});

test('settings merge under one debugger owner and throughput uses bytes per second', async () => {
  const h = harness();
  await h.controller.apply(1, { network: 'slow-3g', cpuRate: 4 });
  await h.controller.apply(1, {
    device: 'phone',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    geolocation: { latitude: 48, longitude: 2 },
  });
  assert.equal(h.owners(), 1);
  assert.equal(h.controller.status(1).config.cpuRate, 4);
  assert.equal(h.commands[0].params.downloadThroughput, 50000);
  assert.equal((await h.controller.reset(1)).reset, true);
  assert.equal(h.owners(), 0);
  assert.equal(h.controller.status(1).active, false);
  assert.ok(!h.commands.some((c) => c.method === 'Network.setExtraHTTPHeaders'));
});

test('partial application remains resettable and reset continues after failures', async () => {
  const h = harness();
  h.fail('Emulation.setTouchEmulationEnabled');
  await assert.rejects(h.controller.apply(1, { device: 'phone' }));
  assert.deepEqual(h.controller.status(1).pendingReset, ['device', 'touch']);
  h.fail('Emulation.clearDeviceMetricsOverride');
  const result = await h.controller.reset(1);
  assert.equal(result.reset, false);
  assert.deepEqual(result.pendingReset, ['device']);
  assert.equal(h.owners(), 1);
  h.fail('');
  assert.equal((await h.controller.reset(1)).reset, true);
  assert.equal(h.owners(), 0);
});

test('external detach invalidates ownership without issuing stale reset commands', async () => {
  const h = harness();
  await h.controller.apply(1, { cpuRate: 4 });
  h.controller.detached(1);
  assert.equal(h.controller.status(1).active, false);
  await h.controller.reset(1);
  assert.equal(h.commands.length, 1);
});

test('concurrent apply and reset are serialized per tab', async () => {
  const h = harness();
  await Promise.all([h.controller.apply(1, { cpuRate: 4 }), h.controller.reset(1)]);
  assert.equal(h.owners(), 0);
  assert.deepEqual(
    h.commands.map((c) => c.params.rate),
    [4, 1]
  );
});

test('detach during acquisition cannot publish a stale emulation owner', async () => {
  let sends = 0;
  const controller = createEmulationController({
    acquire: async () => {
      controller.detached(1);
    },
    release: async () => {
      throw new Error('Must not release a detached owner');
    },
    send: async () => {
      sends++;
    },
  });
  await assert.rejects(controller.apply(1, { cpuRate: 4 }), /detached/);
  assert.equal(sends, 0);
  assert.equal(controller.status(1).active, false);
});

test('detach during reset cancels remaining cleanup commands', async () => {
  let resetting = false;
  const commands: string[] = [];
  const controller = createEmulationController({
    acquire: async () => {},
    release: async () => {
      throw new Error('Must not release a detached owner');
    },
    send: async (_tab, method) => {
      commands.push(method);
      if (resetting) controller.detached(1);
    },
  });
  await controller.apply(1, { cpuRate: 4, locale: 'fr-FR' });
  commands.length = 0;
  resetting = true;
  const result = await controller.reset(1);
  assert.equal(result.reset, false);
  assert.equal(result.active, false);
  assert.deepEqual(commands, ['Emulation.setCPUThrottlingRate']);
});

test('revoked access stops a queued multi-setting apply before its next command', async () => {
  const h = harness();
  let checks = 0;
  await assert.rejects(
    h.controller.apply(1, { device: 'phone', cpuRate: 4 }, async () => {
      if (++checks >= 3) throw new Error('access revoked');
    }),
    /access revoked/
  );
  assert.deepEqual(
    h.commands.map((command) => command.method),
    ['Emulation.setDeviceMetricsOverride']
  );
  assert.deepEqual(h.controller.status(1).pendingReset, ['device']);
  assert.equal((await h.controller.reset(1)).reset, true);
  assert.equal(h.owners(), 0);
});
