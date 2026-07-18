// @ts-check

import { sanitizeOutput } from './cli-helpers.js';
import { CLI_HELP_SECTIONS } from './command-registry.js';
import { annotateBridgeSummary, summarizeBridgeResponse } from './subagent.js';

/**
 * @param {unknown} value
 * @returns {void}
 */
export function printJson(value) {
  process.stdout.write(
    `${JSON.stringify(sanitizeOutput(value), null, process.stdout.isTTY ? 2 : undefined)}\n`
  );
}

/**
 * @param {import('../../protocol/src/types.js').BridgeResponse} response
 * @param {string} [method] - Optional method name for disambiguation
 * @returns {Promise<void>}
 */
export async function printSummary(response, method) {
  if (!response.ok) {
    process.exitCode = 1;
  }
  printJson(annotateBridgeSummary(summarizeBridgeResponse(response, method), response));
}

/**
 * @param {import('../../protocol/src/types.js').BridgeResponse} response
 * @returns {void}
 */
export function printCallResponse(response) {
  if (response.ok) {
    printJson(response.result);
    return;
  }

  process.exitCode = 1;
  const errorText = `${response.error.code}: ${response.error.message}`;
  process.stderr.write(
    `${process.stderr.isTTY ? `\u001b[31m${sanitizeOutput(errorText)}\u001b[0m` : sanitizeOutput(errorText)}\n`
  );
  printJson(response);
}

/**
 * @returns {void}
 */
export function printUsage() {
  const blocks = ['Usage: bbx [--remote <name>] <command> [args]'];
  for (const section of CLI_HELP_SECTIONS) {
    blocks.push('', `${section.title}:`);
    blocks.push(...section.lines.map((line) => `  ${line}`));
  }
  process.stdout.write(`${blocks.join('\n')}\n`);
}
