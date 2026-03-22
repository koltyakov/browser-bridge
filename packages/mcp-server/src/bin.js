#!/usr/bin/env node
// @ts-check

import { startBridgeMcpServer } from './server.js';

startBridgeMcpServer().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
