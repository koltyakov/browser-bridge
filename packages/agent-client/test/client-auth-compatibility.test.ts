import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { BridgeClient } from '../src/client.js';
import { getBridgeAuthTokenPath } from '../../native-host/src/auth-token.js';
import { bridgeServerWith } from '../../../tests/_helpers/socketHarness.ts';

for (const credential of ['present', 'missing', 'unreadable'] as const) {
  test(`local registration remains compatible with ${credential} credentials`, async (t) => {
    const server = await bridgeServerWith({});
    const keys = ['BROWSER_BRIDGE_HOME', 'BBX_AUTH_TOKEN', 'BBX_AUTH_TOKEN_FILE'];
    const previous = keys.map((key) => process.env[key]);
    process.env.BROWSER_BRIDGE_HOME = server.bridgeHome;
    delete process.env.BBX_AUTH_TOKEN;
    delete process.env.BBX_AUTH_TOKEN_FILE;
    const token = 'a'.repeat(43);
    const tokenPath = getBridgeAuthTokenPath();
    const client = new BridgeClient({
      socketPath: server.socketPath,
      checkProtocolOnConnect: false,
    });
    t.after(async () => {
      await client.close();
      await server.close();
      keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key];
        else process.env[key] = previous[i];
      });
    });
    if (credential === 'present') await fs.promises.writeFile(tokenPath, token);
    if (credential === 'unreadable') {
      const read = fs.promises.readFile;
      t.mock.method(fs.promises, 'readFile', (async (
        file: Parameters<typeof fs.promises.readFile>[0],
        options: Parameters<typeof fs.promises.readFile>[1]
      ) => {
        if (String(file) === tokenPath)
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return read(file, options);
      }) as typeof fs.promises.readFile);
    }
    await client.connect();
    assert.deepEqual(server.messages[0], {
      type: 'register',
      role: 'agent',
      clientId: client.clientId,
      ...(credential === 'present' ? { authToken: token } : {}),
    });
    if (credential === 'unreadable') {
      const tcp = new BridgeClient({
        transport: { type: 'tcp', host: '127.0.0.1', port: 9223, label: 'test' },
      });
      await assert.rejects(tcp.readRegistrationAuthToken(), /permission denied/);
    }
  });
}

test('explicit registration credentials remain authoritative on local transports', async () => {
  const token = 'b'.repeat(43);
  assert.equal(await new BridgeClient({ authToken: token }).readRegistrationAuthToken(), token);
  assert.equal(await new BridgeClient({ authToken: null }).readRegistrationAuthToken(), null);
});
