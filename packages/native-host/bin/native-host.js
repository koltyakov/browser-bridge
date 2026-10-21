#!/usr/bin/env node
// @ts-check
import { runNativeHost } from '../src/native-host.js';
import { bundled, forwardToCompanion } from '../../standalone/src/runtime.js';

if (!bundled) await forwardToCompanion(['--native-host', ...process.argv.slice(2)]);

/**
 * Entrypoint used by Chrome Native Messaging to proxy requests between the
 * browser extension and the local bridge daemon.
 */
await runNativeHost();
