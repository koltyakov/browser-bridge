import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runPostinstall } from '../bin/postinstall.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const postinstallPath = path.join(repoRoot, 'packages', 'native-host', 'bin', 'postinstall.js');

type PostinstallDeps = NonNullable<Parameters<typeof runPostinstall>[0]>;
type InstallNativeManifestFn = NonNullable<PostinstallDeps['installNativeManifestFn']>;
type RestartBridgeDaemonIfRunningFn = NonNullable<
  PostinstallDeps['restartBridgeDaemonIfRunningFn']
>;

function createWriteSink() {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
  } satisfies Pick<NodeJS.WriteStream, 'write'>;

  return { chunks, stream };
}

test('runPostinstall installs native host and skips restart message when daemon is stopped', async () => {
  const stdout = createWriteSink();
  const stderr = createWriteSink();
  const installCalls: Parameters<InstallNativeManifestFn>[0][] = [];
  let restartCalls = 0;

  const installNativeManifestFn: InstallNativeManifestFn = async (options) => {
    installCalls.push(options);
    return {
      manifestPath: '/tmp/manifest.json',
      launcherPath: '/tmp/launcher',
      allowedOrigins: [],
      extensionId: null,
    };
  };
  const restartBridgeDaemonIfRunningFn: RestartBridgeDaemonIfRunningFn = async () => {
    restartCalls += 1;
    return null;
  };

  await runPostinstall({
    installNativeManifestFn,
    restartBridgeDaemonIfRunningFn,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(installCalls.length, 1);
  assert.equal(installCalls[0].repoRoot, repoRoot);
  assert.equal(installCalls[0].preserveCustomExtensionId, true);
  assert.equal(restartCalls, 1);
  assert.equal(
    stdout.chunks.join(''),
    'Browser Bridge: native host installed. Run `bbx doctor` to verify.\n'
  );
  assert.equal(stderr.chunks.join(''), '');
});

test('runPostinstall reports daemon restart after successful install', async () => {
  const stdout = createWriteSink();
  const stderr = createWriteSink();

  const installNativeManifestFn: InstallNativeManifestFn = async () => ({
    manifestPath: '/tmp/manifest.json',
    launcherPath: '/tmp/launcher',
    allowedOrigins: [],
    extensionId: null,
  });
  const restartBridgeDaemonIfRunningFn: RestartBridgeDaemonIfRunningFn = async () => ({
    transport: 'tcp:127.0.0.1:9223',
    socketPath: '',
    pidPath: '/tmp/browser-bridge.pid',
    pid: 123,
    previouslyRunning: true,
    previousPid: 122,
    removedStaleSocket: false,
  });

  await runPostinstall({
    installNativeManifestFn,
    restartBridgeDaemonIfRunningFn,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(
    stdout.chunks.join(''),
    'Browser Bridge: native host installed. Run `bbx doctor` to verify.\n' +
      'Browser Bridge: restarted the local daemon to use the updated install.\n'
  );
  assert.equal(stderr.chunks.join(''), '');
});

test('runPostinstall skips install and daemon restart during npm exec', async () => {
  const stdout = createWriteSink();
  const stderr = createWriteSink();
  let installCalls = 0;
  let restartCalls = 0;

  const installNativeManifestFn: InstallNativeManifestFn = async () => {
    installCalls += 1;
    return {
      manifestPath: '/tmp/manifest.json',
      launcherPath: '/tmp/launcher',
      allowedOrigins: [],
      extensionId: null,
    };
  };
  const restartBridgeDaemonIfRunningFn: RestartBridgeDaemonIfRunningFn = async () => {
    restartCalls += 1;
    return {
      transport: 'tcp:127.0.0.1:9223',
      socketPath: '',
      pidPath: '/tmp/browser-bridge.pid',
      pid: 123,
      previouslyRunning: true,
      previousPid: 122,
      removedStaleSocket: false,
    };
  };

  await runPostinstall({
    installNativeManifestFn,
    restartBridgeDaemonIfRunningFn,
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { npm_command: 'exec' },
  });

  assert.equal(installCalls, 0);
  assert.equal(restartCalls, 0);
  assert.equal(stdout.chunks.join(''), '');
  assert.equal(stderr.chunks.join(''), '');
});

test('runPostinstall keeps install success non-fatal when daemon restart fails', async () => {
  const stdout = createWriteSink();
  const stderr = createWriteSink();

  const installNativeManifestFn: InstallNativeManifestFn = async () => ({
    manifestPath: '/tmp/manifest.json',
    launcherPath: '/tmp/launcher',
    allowedOrigins: [],
    extensionId: null,
  });
  const restartBridgeDaemonIfRunningFn: RestartBridgeDaemonIfRunningFn = async () => {
    throw new Error('socket timeout');
  };

  await runPostinstall({
    installNativeManifestFn,
    restartBridgeDaemonIfRunningFn,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(
    stdout.chunks.join(''),
    'Browser Bridge: native host installed. Run `bbx doctor` to verify.\n'
  );
  assert.equal(
    stderr.chunks.join(''),
    'Browser Bridge: native host installed, but daemon restart failed (socket timeout).\n' +
      'Run `bbx restart` if needed.\n'
  );
});

test('runPostinstall stringifies non-Error restart failures', async () => {
  const stdout = createWriteSink();
  const stderr = createWriteSink();

  const installNativeManifestFn: InstallNativeManifestFn = async () => ({
    manifestPath: '/tmp/manifest.json',
    launcherPath: '/tmp/launcher',
    allowedOrigins: [],
    extensionId: null,
  });
  const restartBridgeDaemonIfRunningFn: RestartBridgeDaemonIfRunningFn = async () => {
    throw 'restart unavailable';
  };

  await runPostinstall({
    installNativeManifestFn,
    restartBridgeDaemonIfRunningFn,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.match(stderr.chunks.join(''), /restart unavailable/);
});

test('runPostinstall exits zero and skips restart when native host install fails', async () => {
  const stdout = createWriteSink();
  const stderr = createWriteSink();
  let exitCode: number | undefined;
  let restartCalls = 0;

  const installNativeManifestFn: InstallNativeManifestFn = async () => {
    throw new Error('invalid extension id');
  };
  const restartBridgeDaemonIfRunningFn: RestartBridgeDaemonIfRunningFn = async () => {
    restartCalls += 1;
    return null;
  };

  await runPostinstall({
    installNativeManifestFn,
    restartBridgeDaemonIfRunningFn,
    stdout: stdout.stream,
    stderr: stderr.stream,
    exit: (code) => {
      exitCode = code;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(restartCalls, 0);
  assert.equal(stdout.chunks.join(''), '');
  assert.equal(
    stderr.chunks.join(''),
    'Browser Bridge: native host auto-install skipped (invalid extension id).\n' +
      'Run `bbx install` manually if needed.\n'
  );
});

test('runPostinstall stringifies non-Error install failures', async () => {
  const stdout = createWriteSink();
  const stderr = createWriteSink();
  let exitCode: number | undefined;

  const installNativeManifestFn: InstallNativeManifestFn = async () => {
    throw 'install unavailable';
  };

  await runPostinstall({
    installNativeManifestFn,
    restartBridgeDaemonIfRunningFn: async () => null,
    stdout: stdout.stream,
    stderr: stderr.stream,
    exit: (code) => {
      exitCode = code;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.chunks.join(''), '');
  assert.match(stderr.chunks.join(''), /install unavailable/);
});

test('postinstall exits successfully when native host auto-install fails', () => {
  const result = spawnSync(process.execPath, [postinstallPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      BROWSER_BRIDGE_EXTENSION_ID: 'invalid',
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Browser Bridge: native host auto-install skipped/);
  assert.match(result.stderr, /Invalid BROWSER_BRIDGE_EXTENSION_ID: invalid/);
  assert.match(result.stderr, /Run `bbx install` manually if needed\./);
});
