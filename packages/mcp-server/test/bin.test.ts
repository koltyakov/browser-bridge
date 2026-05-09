import test from 'node:test';
import assert from 'node:assert/strict';

import { runBridgeMcpCli } from '../src/bin.js';

test('runBridgeMcpCli prints usage and exits successfully for --help', async () => {
  let startCalls = 0;
  let stdoutOutput = '';
  let exitCode: number | null = null;

  const statusCode = await runBridgeMcpCli({
    argv: ['--help'],
    start: async () => {
      startCalls += 1;
    },
    stdout: {
      write(chunk: string) {
        stdoutOutput += chunk;
      },
    },
    exit(code: number) {
      exitCode = code;
    },
  });

  assert.equal(statusCode, 0);
  assert.equal(startCalls, 0);
  assert.equal(exitCode, null);
  assert.match(stdoutOutput, /Usage: bbx-mcp \[--help\]/);
  assert.match(stdoutOutput, /Browser Bridge MCP stdio server/);
});

test('runBridgeMcpCli starts the MCP server without writing errors', async () => {
  let startCalls = 0;
  let exitCode: number | null = null;
  let stderrOutput = '';

  const statusCode = await runBridgeMcpCli({
    start: async () => {
      startCalls += 1;
    },
    stderr: {
      write(chunk: string) {
        stderrOutput += chunk;
      },
    },
    exit(code: number) {
      exitCode = code;
    },
  });

  assert.equal(statusCode, 0);
  assert.equal(startCalls, 1);
  assert.equal(exitCode, null);
  assert.equal(stderrOutput, '');
});

test('runBridgeMcpCli writes stack traces and exits 1 on startup failure', async () => {
  let exitCode: number | null = null;
  let stderrOutput = '';
  const error = new Error('stdio failed');
  error.stack = 'Error: stdio failed\n    at startBridgeMcpServer (server.js:1:1)';

  const statusCode = await runBridgeMcpCli({
    start: async () => {
      throw error;
    },
    stderr: {
      write(chunk: string) {
        stderrOutput += chunk;
      },
    },
    exit(code: number) {
      exitCode = code;
    },
  });

  assert.equal(statusCode, 1);
  assert.equal(exitCode, 1);
  assert.match(stderrOutput, /Error: stdio failed/);
  assert.match(stderrOutput, /server\.js:1:1/);
  assert.match(stderrOutput, /\n$/);
});

test('runBridgeMcpCli stringifies non-Error startup failures', async () => {
  let exitCode: number | null = null;
  let stderrOutput = '';

  const statusCode = await runBridgeMcpCli({
    start: async () => {
      throw 'bridge unavailable';
    },
    stderr: {
      write(chunk: string) {
        stderrOutput += chunk;
      },
    },
    exit(code: number) {
      exitCode = code;
    },
  });

  assert.equal(statusCode, 1);
  assert.equal(exitCode, 1);
  assert.equal(stderrOutput, 'bridge unavailable\n');
});
