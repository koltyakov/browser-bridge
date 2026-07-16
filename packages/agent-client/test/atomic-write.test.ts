import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteFile } from '../src/atomic-write.js';

type RenameCall = { source: string; destination: string };

function replaceError(code: 'EACCES' | 'EEXIST' | 'EPERM', message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

async function withWindowsPlatform(callback: () => Promise<void>): Promise<void> {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  });
  try {
    await callback();
  } finally {
    assert.ok(platformDescriptor);
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
}

test('atomicWriteFile replaces an existing Windows target through a backup', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-atomic-write-'));
  const targetPath = path.join(directory, 'settings.json');
  const renameDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'rename');
  const originalRename = fs.promises.rename.bind(fs.promises);
  const calls: RenameCall[] = [];
  let initialReplaceAttempt = true;

  await fs.promises.writeFile(targetPath, 'old', 'utf8');
  Object.defineProperty(fs.promises, 'rename', {
    configurable: true,
    async value(source: fs.PathLike, destination: fs.PathLike) {
      const call = { source: String(source), destination: String(destination) };
      calls.push(call);
      if (
        initialReplaceAttempt &&
        call.destination === targetPath &&
        call.source.endsWith('.tmp')
      ) {
        initialReplaceAttempt = false;
        throw replaceError('EEXIST', 'target exists');
      }
      await originalRename(source, destination);
    },
  });

  try {
    await withWindowsPlatform(() => atomicWriteFile(targetPath, 'new', { encoding: 'utf8' }));

    assert.equal(await fs.promises.readFile(targetPath, 'utf8'), 'new');
    assert.equal(calls.length, 3);
    assert.equal(calls[0].destination, targetPath);
    assert.equal(calls[1].source, targetPath);
    assert.equal(calls[1].destination, `${calls[0].source}.backup`);
    assert.deepEqual(calls[2], { source: calls[0].source, destination: targetPath });
    assert.deepEqual(await fs.promises.readdir(directory), ['settings.json']);
  } finally {
    assert.ok(renameDescriptor);
    Object.defineProperty(fs.promises, 'rename', renameDescriptor);
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('atomicWriteFile restores the Windows backup when replacement fails', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-atomic-rollback-'));
  const targetPath = path.join(directory, 'settings.json');
  const renameDescriptor = Object.getOwnPropertyDescriptor(fs.promises, 'rename');
  const originalRename = fs.promises.rename.bind(fs.promises);
  const replacementFailure = replaceError('EACCES', 'replacement denied');
  const calls: RenameCall[] = [];
  let targetAttempts = 0;

  await fs.promises.writeFile(targetPath, 'old', 'utf8');
  Object.defineProperty(fs.promises, 'rename', {
    configurable: true,
    async value(source: fs.PathLike, destination: fs.PathLike) {
      const call = { source: String(source), destination: String(destination) };
      calls.push(call);
      if (call.destination === targetPath && call.source.endsWith('.tmp')) {
        targetAttempts += 1;
        if (targetAttempts === 1) {
          throw replaceError('EPERM', 'target is locked');
        }
        throw replacementFailure;
      }
      await originalRename(source, destination);
    },
  });

  try {
    await assert.rejects(
      withWindowsPlatform(() => atomicWriteFile(targetPath, 'new', { encoding: 'utf8' })),
      (error: unknown) => error === replacementFailure
    );

    assert.equal(await fs.promises.readFile(targetPath, 'utf8'), 'old');
    assert.equal(calls.length, 4);
    assert.equal(calls[1].source, targetPath);
    assert.deepEqual(calls[3], { source: calls[1].destination, destination: targetPath });
    assert.deepEqual(await fs.promises.readdir(directory), ['settings.json']);
  } finally {
    assert.ok(renameDescriptor);
    Object.defineProperty(fs.promises, 'rename', renameDescriptor);
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
