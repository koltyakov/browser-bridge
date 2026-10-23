import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../../../scripts/check-go-format.mjs', import.meta.url));
const goAvailable = spawnSync('go', ['version']).status === 0;

test(
  'Go formatting check reports unformatted files without changing them',
  { skip: !goAvailable },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-go-format-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.mkdir(path.join(directory, 'cmd'));
    await fs.mkdir(path.join(directory, 'internal'));
    const file = path.join(directory, 'cmd', 'main.go');
    const unformatted = 'package main\nfunc main(){println("fixture")}\n';
    await fs.writeFile(file, unformatted);

    const failed = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Go files need formatting:/u);
    assert(failed.stderr.includes(path.join('cmd', 'main.go')));
    assert.match(failed.stderr, /Run make format-go/u);
    assert.doesNotMatch(failed.stderr, /Error:|\bat .*:\d+:\d+/u);
    assert.equal(await fs.readFile(file, 'utf8'), unformatted);

    assert.equal(spawnSync('gofmt', ['-w', file]).status, 0);
    const passed = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
    assert.equal(passed.status, 0);
    assert.equal(passed.stdout, '');
    assert.equal(passed.stderr, '');

    await fs.writeFile(file, 'invalid Go syntax\n');
    const invalid = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.notEqual(invalid.stderr, '');
  }
);
