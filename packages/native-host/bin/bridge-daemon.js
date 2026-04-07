#!/usr/bin/env node
// @ts-check
import { BridgeDaemon } from '../src/daemon.js';
import { getSocketPath } from '../src/config.js';

const daemon = new BridgeDaemon({ socketPath: getSocketPath() });
await daemon.start();

process.stdout.write(`Browser Bridge daemon listening on ${getSocketPath()}\n`);

let shuttingDown = false;

/**
 * @returns {Promise<void>}
 */
async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  try {
    await daemon.stop();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    void shutdown();
  });
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `Unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`
  );
});

process.on('uncaughtException', (error) => {
  process.stderr.write(
    `Uncaught exception: ${error instanceof Error ? error.stack : String(error)}\n`
  );
  void shutdown();
});
