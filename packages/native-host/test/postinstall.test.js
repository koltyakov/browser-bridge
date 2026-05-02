// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const postinstallPath = path.join(repoRoot, 'packages', 'native-host', 'bin', 'postinstall.js');

test('postinstall exits successfully when native host auto-install fails', () => {
  const result = spawnSync(process.execPath, [postinstallPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      BROWSER_BRIDGE_EXTENSION_ID: 'invalid',
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Browser Bridge: native host auto-install skipped/);
  assert.match(result.stderr, /Invalid BROWSER_BRIDGE_EXTENSION_ID: invalid/);
  assert.match(result.stderr, /Run `bbx install` manually if needed\./);
});
