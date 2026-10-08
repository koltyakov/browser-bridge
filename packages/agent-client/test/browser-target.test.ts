import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCallCommand } from '../src/cli-args.js';
import { BridgeClient } from '../src/client.js';
import { requestBridge } from '../src/runtime.js';
import { runBatchCalls } from '../src/cli-batch.js';
import { makeSuccess } from '../../../tests/_helpers/protocolFactories.ts';

test('raw CLI parses browser selectors separately from page params', async () => {
  const parsed = await parseCallCommand([
    'page.get_text',
    '{"textBudget":400}',
    '--extension',
    'work-connection',
    '--profile',
    'Work',
    '--browser',
    'Chrome',
    '--tab',
    '42',
  ]);
  assert.deepEqual(parsed, {
    method: 'page.get_text',
    params: { textBudget: 400 },
    tabId: 42,
    extensionId: 'work-connection',
    targetBrowser: 'Chrome',
    targetProfile: 'Work',
  });
  for (const flag of ['--extension', '--browser', '--profile']) {
    await assert.rejects(
      parseCallCommand([flag, '--tab', '42', 'page.get_state']),
      /requires a value/
    );
    await assert.rejects(parseCallCommand([flag, ' ', 'page.get_state']), /requires a value/);
  }
});

test('runtime and CLI batches forward connection selectors as metadata', async (t) => {
  const client = new BridgeClient({ checkProtocolOnConnect: false });
  client.connected = true;
  const requests: Array<Parameters<BridgeClient['request']>[0]> = [];
  t.mock.method(client, 'request', async (request: Parameters<BridgeClient['request']>[0]) => {
    requests.push(request);
    return makeSuccess({});
  });
  await requestBridge(
    client,
    'page.get_state',
    {},
    { extensionId: 'work', targetBrowser: 'Chrome', targetProfile: 'Work', tabId: 42 }
  );
  assert.equal(requests[0].meta?.target_extension, 'work');
  assert.equal(requests[0].meta?.target_browser, 'Chrome');
  assert.equal(requests[0].meta?.target_profile, 'Work');
  assert.equal(requests[0].tabId, 42);
  await runBatchCalls(
    client,
    JSON.stringify(
      ['work', 'personal'].map((extensionId) => ({
        method: 'page.get_state',
        extensionId,
        tabId: 42,
      }))
    ),
    'cli'
  );
  assert.deepEqual(
    requests.slice(1).map((request) => request.meta?.target_extension),
    ['work', 'personal']
  );
  const invalid = await runBatchCalls(
    client,
    '[{"method":"page.get_state","extensionId":42}]',
    'cli'
  );
  assert.equal(invalid[0].ok, false);
  assert.equal(requests.length, 3);
});
