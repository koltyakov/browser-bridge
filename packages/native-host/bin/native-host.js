#!/usr/bin/env node
// @ts-check
import { runNativeHost } from '../src/native-host.js';

/**
 * Entrypoint used by Chrome Native Messaging to proxy requests between the
 * browser extension and the local bridge daemon.
 */
await runNativeHost();
