#!/usr/bin/env node
// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installNativeManifest, parseExtensionId } from '../src/install-manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const extensionIdArg = process.argv[2];

if (extensionIdArg && !parseExtensionId(extensionIdArg)) {
  process.stderr.write(
    `Invalid extension ID: ${extensionIdArg}\n` +
    'Expected 32 lowercase letters (e.g. abcdefghijklmnopabcdefghijklmnop)\n'
  );
  process.exit(1);
}

await installNativeManifest({
  repoRoot,
  extensionIdArg
});
