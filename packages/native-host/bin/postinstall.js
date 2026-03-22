#!/usr/bin/env node
// @ts-check
/**
 * npm postinstall hook - auto-installs the native messaging manifest so
 * `npm install -g @browserbridge/bbx` is fully self-contained.
 *
 * Always exits 0 so installation never fails in CI or non-Chrome environments.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installNativeManifest } from '../src/install-manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

try {
  await installNativeManifest({ repoRoot });
  process.stdout.write('Browser Bridge: native host installed. Run `bbx doctor` to verify.\n');
} catch (err) {
  // Non-fatal - user can run `bbx install` manually.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Browser Bridge: native host auto-install skipped (${message}).\nRun \`bbx install\` manually if needed.\n`);
}
