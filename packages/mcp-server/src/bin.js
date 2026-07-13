#!/usr/bin/env node
// @ts-check

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tryStartMcpProcessControl } from './lifecycle.js';
import { startBridgeMcpServer } from './server.js';

/**
 * @typedef {{
 *   start?: () => Promise<void>,
 *   startControl?: typeof tryStartMcpProcessControl,
 *   argv?: string[],
 *   stdout?: { write: (chunk: string) => unknown },
 *   stderr?: { write: (chunk: string) => unknown },
 *   exit?: (code: number) => unknown,
 * }} BridgeMcpCliOptions
 */

const HELP_FLAGS = new Set(['help', '--help', '-h']);

const MCP_USAGE = [
  'Usage: bbx-mcp [--help]',
  '',
  'Start the Browser Bridge MCP stdio server.',
].join('\n');

/**
 * Start the MCP server CLI and report startup failures to stderr.
 *
 * @param {BridgeMcpCliOptions} [options]
 * @returns {Promise<number>}
 */
export async function runBridgeMcpCli(options = {}) {
  const {
    start = startBridgeMcpServer,
    startControl = tryStartMcpProcessControl,
    argv = process.argv.slice(2),
    stdout = process.stdout,
    stderr = process.stderr,
    exit = process.exit,
  } = options;

  if (argv.some((arg) => HELP_FLAGS.has(arg))) {
    stdout.write(`${MCP_USAGE}\n`);
    return 0;
  }

  try {
    const control = await startControl();
    try {
      await start();
    } catch (error) {
      await control?.dispose();
      throw error;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    stderr.write(`${message}\n`);
    exit(1);
    return 1;
  }
}

const entryPointUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;

if (entryPointUrl === import.meta.url) {
  void runBridgeMcpCli();
}
