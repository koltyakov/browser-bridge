// @ts-check
import { bundled, forwardToCompanion, getVersionExecutable, readInstallation } from './runtime.js';
import { applyWindowsTcpTransportDefaults } from '../../native-host/src/config.js';

try {
  const args = process.argv.slice(2);
  const mode = args[0];
  applyWindowsTcpTransportDefaults();
  if (mode !== '--self-test') await forwardToCompanion(args);

  if (mode === '--self-test') {
    // Import the server and parsers too: --version alone does not exercise bundled dependencies.
    await import('../../mcp-server/src/server.js');
    await import('../../agent-client/src/content-extract.js');
    process.stdout.write(
      `${JSON.stringify({ version: bundled?.version, target: bundled?.target })}\n`
    );
  } else if (mode === '--bridge-daemon') {
    await import('../../native-host/bin/bridge-daemon.js');
  } else if (mode === '--native-host' || /^chrome-extension:\/\/[a-z]{32}\/$/.test(mode ?? '')) {
    await import('../../native-host/bin/native-host.js');
  } else if (mode === 'setup') {
    const { installCompanion } = await import('./installer.js');
    const projects = [];
    for (let index = 1; index < args.length; index += 2) {
      if (args[index] !== '--project' || !args[index + 1])
        throw new Error('Usage: bbx setup [--project <path>]');
      projects.push(args[index + 1]);
    }
    await installCompanion({ projects });
  } else if (mode === 'rollback') {
    const previous = readInstallation()?.previousVersion;
    if (!previous) throw new Error('There is no previous companion version to restore.');
    const { installCompanion } = await import('./installer.js');
    await installCompanion({
      source: getVersionExecutable(previous),
      version: previous,
      allowDowngrade: true,
    });
  } else if (mode === 'update') {
    const { updateCompanion } = await import('./updater.js');
    await updateCompanion();
  } else if (mode === '--auto-update') {
    const { checkAutomaticUpdate } = await import('./updater.js');
    await checkAutomaticUpdate();
  } else if (mode === '--install-manifest') {
    process.argv.splice(2, 1);
    await import('../../native-host/bin/install-manifest.js');
  } else {
    await import('../../agent-client/src/cli.js');
  }
} catch (error) {
  process.stderr.write(
    `Browser Bridge: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
