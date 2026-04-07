#!/usr/bin/env node
// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installNativeManifest, parseExtensionId } from '../src/install-manifest.js';
import { SUPPORTED_BROWSERS } from '../src/config.js';

/** @typedef {import('../src/config.js').SupportedBrowser} SupportedBrowser */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const args = process.argv.slice(2);
let extensionIdArg = /** @type {string | undefined} */ (undefined);
let installAll = false;
const browsers = /** @type {SupportedBrowser[]} */ ([]);

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') {
    installAll = true;
  } else if (args[i] === '--browser' && args[i + 1]) {
    const candidate = args[i + 1];
    if (!SUPPORTED_BROWSERS.includes(/** @type {SupportedBrowser} */ (candidate))) {
      process.stderr.write(
        `Unsupported browser: ${candidate}\nSupported: ${SUPPORTED_BROWSERS.join(', ')}\n`
      );
      process.exit(1);
    }
    browsers.push(/** @type {SupportedBrowser} */ (candidate));
    i++;
  } else if (!extensionIdArg) {
    extensionIdArg = args[i];
  }
}

if (extensionIdArg && !parseExtensionId(extensionIdArg)) {
  process.stderr.write(
    `Invalid extension ID: ${extensionIdArg}\n` +
      'Expected 32 lowercase letters (e.g. abcdefghijklmnopabcdefghijklmnop)\n'
  );
  process.exit(1);
}

const targets = installAll
  ? [...SUPPORTED_BROWSERS]
  : browsers.length > 0
    ? browsers
    : [/** @type {SupportedBrowser} */ ('chrome')];

for (const target of targets) {
  await installNativeManifest({
    repoRoot,
    extensionIdArg,
    browser: target,
  });
}
