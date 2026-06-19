import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ensureBridgeAuthToken,
  BRIDGE_AUTH_TOKEN_ENV,
  BRIDGE_AUTH_TOKEN_FILE_ENV,
  getBridgeAuthTokenPath,
  normalizeBridgeAuthToken,
  readBridgeAuthToken,
  readBridgeAuthTokenOverride,
  writeBridgeAuthToken,
} from '../src/auth-token.js';

const GENERATED_TOKEN = Buffer.from('abcdefghijklmnopqrstuvwxyz123456').toString('base64url');

function mockReadFile(fn: () => Promise<string>): typeof fs.promises.readFile {
  return fn as unknown as typeof fs.promises.readFile;
}

test('getBridgeAuthTokenPath resolves under the configured bridge home', () => {
  assert.equal(
    getBridgeAuthTokenPath({ BROWSER_BRIDGE_HOME: '/tmp/browser-bridge-test' }),
    path.join('/tmp/browser-bridge-test', 'daemon.auth')
  );
});

test('normalizeBridgeAuthToken rejects non-strings and invalid strings', () => {
  assert.equal(normalizeBridgeAuthToken(undefined), null);
  assert.equal(normalizeBridgeAuthToken('short'), null);
  assert.equal(normalizeBridgeAuthToken('contains spaces and punctuation!'), null);
});

test('normalizeBridgeAuthToken trims and accepts valid URL-safe tokens', () => {
  assert.equal(
    normalizeBridgeAuthToken('  abcdefghijklmnopqrstuvwxyzABCDEF_-  '),
    'abcdefghijklmnopqrstuvwxyzABCDEF_-'
  );
});

test('normalizeBridgeAuthToken accepts UUID proxy tokens', () => {
  assert.equal(
    normalizeBridgeAuthToken('  6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237  '),
    '6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237'
  );
});

test('readBridgeAuthTokenOverride prefers env token before token file', async () => {
  assert.equal(
    await readBridgeAuthTokenOverride({
      env: {
        [BRIDGE_AUTH_TOKEN_ENV]: '6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237',
        [BRIDGE_AUTH_TOKEN_FILE_ENV]: '/tmp/token',
      },
      readFile: mockReadFile(async () => {
        throw new Error('should not read file');
      }),
    }),
    '6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237'
  );
});

test('readBridgeAuthTokenOverride reads token file fallback', async () => {
  assert.equal(
    await readBridgeAuthTokenOverride({
      env: { [BRIDGE_AUTH_TOKEN_FILE_ENV]: '/tmp/token' },
      readFile: mockReadFile(async () => '6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237\n'),
    }),
    '6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237'
  );
});

test('readBridgeAuthToken returns null for missing token file', async () => {
  const readFile = async (): Promise<string> => {
    const error = new Error('missing') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  };

  assert.equal(
    await readBridgeAuthToken({
      tokenPath: '/tmp/missing',
      readFile: mockReadFile(readFile),
    }),
    null
  );
});

test('readBridgeAuthToken rethrows non-missing read errors', async () => {
  const readError = new Error('permission denied');
  const readFile = async (): Promise<string> => {
    throw readError;
  };

  await assert.rejects(
    readBridgeAuthToken({
      tokenPath: '/tmp/token',
      readFile: mockReadFile(readFile),
    }),
    readError
  );
});

test('ensureBridgeAuthToken reuses an existing valid token', async () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEF_-';
  let wrote = false;

  const result = await ensureBridgeAuthToken({
    tokenPath: '/tmp/token',
    readFile: mockReadFile(async () => `${token}\n`),
    writeFile: async () => {
      wrote = true;
    },
  });

  assert.equal(result, token);
  assert.equal(wrote, false);
});

test('ensureBridgeAuthToken creates a token file when none exists', async () => {
  const calls: string[] = [];
  const tokenPath = path.join('/tmp/browser-bridge-test', 'daemon.auth');

  const token = await ensureBridgeAuthToken({
    tokenPath,
    readFile: mockReadFile(async () => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
    mkdir: async (dir, options) => {
      calls.push(`mkdir:${String(dir)}:${JSON.stringify(options)}`);
    },
    writeFile: async (file, data, options) => {
      calls.push(`write:${String(file)}:${String(data)}:${JSON.stringify(options)}`);
    },
    chmod: async (file, mode) => {
      calls.push(`chmod:${String(file)}:${String(mode)}`);
    },
    randomBytesFn: () => Buffer.from('abcdefghijklmnopqrstuvwxyz123456'),
  });

  assert.equal(token, GENERATED_TOKEN);
  assert.deepEqual(calls, [
    `mkdir:${path.dirname(tokenPath)}:{"recursive":true}`,
    `write:${tokenPath}:${GENERATED_TOKEN}\n:{"encoding":"utf8","mode":384}`,
    `chmod:${tokenPath}:384`,
  ]);
});

test('ensureBridgeAuthToken ignores chmod failures after writing the token', async () => {
  const token = await ensureBridgeAuthToken({
    tokenPath: '/tmp/token',
    readFile: mockReadFile(async () => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
    mkdir: async () => {},
    writeFile: async () => {},
    chmod: async () => {
      throw new Error('chmod unavailable');
    },
    randomBytesFn: () => Buffer.from('abcdefghijklmnopqrstuvwxyz123456'),
  });

  assert.equal(token, GENERATED_TOKEN);
});

test('writeBridgeAuthToken persists explicit UUID token with private mode', async () => {
  const calls: string[] = [];
  const tokenPath = path.join('/tmp/browser-bridge-test', 'daemon.auth');

  const token = await writeBridgeAuthToken('6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237', {
    tokenPath,
    mkdir: async (dir, options) => {
      calls.push(`mkdir:${String(dir)}:${JSON.stringify(options)}`);
    },
    writeFile: async (file, data, options) => {
      calls.push(`write:${String(file)}:${String(data)}:${JSON.stringify(options)}`);
    },
    chmod: async (file, mode) => {
      calls.push(`chmod:${String(file)}:${String(mode)}`);
    },
  });

  assert.equal(token, '6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237');
  assert.deepEqual(calls, [
    `mkdir:${path.dirname(tokenPath)}:{"recursive":true}`,
    `write:${tokenPath}:6f7b4e4a-7b9e-4c0d-9e62-4b1fb9f8d237\n:{"encoding":"utf8","mode":384}`,
    `chmod:${tokenPath}:384`,
  ]);
});
