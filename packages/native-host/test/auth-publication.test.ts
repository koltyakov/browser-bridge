import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureBridgeAuthToken, ensureBridgeExtensionAuthToken } from '../src/auth-token.js';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-token-publication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, tokenPath: path.join(root, 'credential') };
}

for (const invalid of ['', 'incomplete-token']) {
  test(`concurrent initialization repairs ${invalid ? 'invalid' : 'empty'} credentials`, async (t) => {
    const { root, tokenPath } = fixture(t);
    fs.writeFileSync(tokenPath, invalid);
    const tokens = await Promise.all(
      Array.from({ length: 16 }, () => ensureBridgeAuthToken({ tokenPath }))
    );
    assert.equal(new Set(tokens).size, 1);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), `${tokens[0]}\n`);
    assert.deepEqual(fs.readdirSync(root), ['credential']);
  });
}

test('failed partial staging writes do not publish a credential and allow retry', async (t) => {
  const { root, tokenPath } = fixture(t);
  const noSpace = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  await assert.rejects(
    ensureBridgeAuthToken({
      tokenPath,
      writeFile: async (file, _data, options) => {
        await fs.promises.writeFile(file, 'partial', options);
        throw noSpace;
      },
    }),
    noSpace
  );
  assert.deepEqual(fs.readdirSync(root), []);
  const token = await ensureBridgeAuthToken({ tokenPath });
  assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), token);
});

test('publication failure releases the lock and permits another initializer', async (t) => {
  const { root, tokenPath } = fixture(t);
  fs.writeFileSync(tokenPath, 'invalid');
  const noSpace = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  await assert.rejects(
    ensureBridgeAuthToken({
      tokenPath,
      link: async (source, target) => {
        if (target === tokenPath) throw noSpace;
        await fs.promises.link(source, target);
      },
    }),
    noSpace
  );
  assert.deepEqual(fs.readdirSync(root), []);
  const token = await ensureBridgeAuthToken({ tokenPath });
  assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), token);
});

for (const initial of [null, '', 'bad-token']) {
  test(`a paused incomplete write preserves a concurrent winner, initial=${JSON.stringify(initial)}`, async (t) => {
    const { tokenPath } = fixture(t);
    if (initial !== null) fs.writeFileSync(tokenPath, initial);
    let started: (() => void) | undefined;
    const staging = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resume: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const slow = ensureBridgeAuthToken({
      tokenPath,
      writeFile: async (file, data, options) => {
        if (String(file).endsWith('.tmp')) {
          await fs.promises.writeFile(file, 'incomplete', options);
          started?.();
          await paused;
          await fs.promises.writeFile(file, data);
        } else await fs.promises.writeFile(file, data, options);
      },
    });
    try {
      await staging;
      assert.equal(fs.existsSync(tokenPath), initial !== null);
      if (initial !== null) assert.equal(fs.readFileSync(tokenPath, 'utf8'), initial);
      const winner = await ensureBridgeAuthToken({ tokenPath });
      resume?.();
      assert.equal(await slow, winner);
      assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), winner);
    } finally {
      resume?.();
      await slow.catch(() => {});
    }
  });
}

test('concurrent recovery follows dead-owner locks without deleting a new owner lock', async (t) => {
  const { tokenPath } = fixture(t);
  fs.writeFileSync(tokenPath, '');
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(`${tokenPath}.init.lock`, `999999:${first}\n`);
  fs.writeFileSync(`${tokenPath}.init-${first}.lock`, `999999:${second}\n`);
  fs.writeFileSync(`${tokenPath}.abandoned.tmp`, 'partial');
  const originalKill = process.kill;
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    if (pid === 999999) throw Object.assign(new Error('dead owner'), { code: 'ESRCH' });
    return originalKill(pid, signal);
  });
  const tokens = await Promise.all(
    Array.from({ length: 12 }, () => ensureBridgeExtensionAuthToken({ tokenPath }))
  );
  assert.equal(new Set(tokens).size, 1);
  assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), tokens[0]);
  assert.equal(fs.existsSync(`${tokenPath}.init-${second}.lock`), false);
  assert.equal(fs.readFileSync(`${tokenPath}.init.lock`, 'utf8'), `999999:${first}\n`);
});
