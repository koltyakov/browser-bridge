#!/usr/bin/env node
// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installNativeManifest, parseExtensionId } from '../src/install-manifest.js';
import { SUPPORTED_BROWSERS } from '../src/config.js';

/** @typedef {import('../src/config.js').SupportedBrowser} SupportedBrowser */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

// Parse args: optional positional extension-id, optional --browser <name>
const args = process.argv.slice(2);
let extensionIdArg = /** @type {string | undefined} */ (undefined);
let browser = /** @type {SupportedBrowser | undefined} */ (undefined);

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--browser' && args[i + 1]) {
    const candidate = args[i + 1];
    if (!SUPPORTED_BROWSERS.includes(/** @type {SupportedBrowser} */ (candidate))) {
      process.stderr.write(
        `Unsupported browser: ${candidate}\nSupported: ${SUPPORTED_BROWSERS.join(', ')}\n`
      );
      process.exit(1);
    }
    browser = /** @type {SupportedBrowser} */ (candidate);
    i++; // skip value arg
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

await installNativeManifest({
  repoRoot,
  extensionIdArg,
  browser
});
