import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getInstalledEntrypoint, handoffUpdatedRuntime } from '../src/update-handoff.js';

test('handoff resolves the new npm entrypoint rather than a deleted v1 source file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-handoff-'));
  try {
    await fs.mkdir(path.join(root, 'packages/npm/bin'), { recursive: true });
    const output = path.join(root, 'handoff.json');
    await fs.writeFile(
      path.join(root, 'packages/npm/bin/bbx.js'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2),policy:process.env.BBX_AUTO_UPDATE})); process.exitCode=7;`
    );
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        version: '2.0.0',
        bin: { bbx: 'packages/npm/bin/bbx.js', 'bbx-mcp': 'packages/npm/bin/bbx.js' },
      })
    );
    assert.equal(getInstalledEntrypoint('bbx', root), path.join(root, 'packages/npm/bin/bbx.js'));
    assert.equal(handoffUpdatedRuntime('bbx', ['call', 'input.click', '{}'], { root }), 7);
    assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), {
      args: ['call', 'input.click', '{}'],
      policy: 'off',
    });
    assert.equal(handoffUpdatedRuntime('bbx-mcp', [], { root }), 7);
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ bin: { bbx: '../outside.js' } })
    );
    assert.throws(() => getInstalledEntrypoint('bbx', root), /outside its package/);
    assert.throws(() => getInstalledEntrypoint('bbx-mcp', root), /Missing installed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
