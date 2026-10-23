import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Go coverage gates weight statements separately for runtime and protocol', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-go-coverage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'go.out');
  const prefix = 'github.com/koltyakov/browser-bridge/internal/';
  for (const [runtimeCovered, protocolCovered, passes] of [
    [68, 85, true],
    [67, 100, false],
    [100, 84, false],
  ] as const) {
    await fs.writeFile(
      filename,
      `mode: atomic\n${prefix}bridge/client.go:1.1,2.2 ${runtimeCovered} 2\n${prefix}bridge/client.go:3.1,4.2 ${100 - runtimeCovered} 0\n${prefix}protocol/json.go:1.1,2.2 ${protocolCovered} 1\n${prefix}protocol/json.go:3.1,4.2 ${100 - protocolCovered} 0\n`
    );
    const run = () =>
      execFileSync(process.execPath, ['scripts/check-go-coverage.mjs', filename], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    if (passes) assert.match(run(), /68\.00%/);
    else assert.throws(run, { status: 1 });
  }
  await fs.writeFile(filename, 'mode: atomic\n');
  assert.throws(
    () =>
      execFileSync(process.execPath, ['scripts/check-go-coverage.mjs', filename], {
        stdio: 'pipe',
      }),
    { status: 1 }
  );
});
