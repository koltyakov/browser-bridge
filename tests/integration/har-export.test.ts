import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createSuccess } from '../../protocol/src/index.js';
import { bridgeServerWith } from '../_helpers/socketHarness.ts';
import { isolatedBridgeEnv, runCli } from '../_helpers/runCli.ts';

test('Go CLI rejects an invalid inline HAR without creating the output file', async () => {
  const bridge = await bridgeServerWith({
    'network.export_har': (request) =>
      createSuccess(request.id, { delivery: 'inline', har: { notALog: true } }),
  });
  try {
    const outputPath = path.join(bridge.bridgeHome, 'export.har');
    const result = await runCli({
      args: ['har', '--delivery', 'inline', outputPath],
      env: isolatedBridgeEnv({ ...process.env, BROWSER_BRIDGE_HOME: bridge.bridgeHome }),
    });
    assert.equal(result.status, 1);
    const payload = result.json as { ok: boolean; summary: string };
    assert.equal(payload.ok, false);
    assert.match(payload.summary, /valid HAR 1\.2 document/);
    assert.equal(fs.existsSync(outputPath), false);
    assert.deepEqual(
      bridge.requests.map((request) => request.method),
      ['network.export_har']
    );
    assert.deepEqual(bridge.errors, []);
  } finally {
    await bridge.close();
  }
});
