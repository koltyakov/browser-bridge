// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  BRIDGE_HOME_ENV,
  getBridgeDir,
  getLauncherFilename,
  getManifestInstallDir,
  getSocketPath,
} from '../src/config.js';

/**
 * @param {{
 *   platform?: NodeJS.Platform,
 *   home?: string,
 *   env?: Record<string, string | undefined>
 * }} options
 * @param {() => void | Promise<void>} callback
 * @returns {Promise<void>}
 */
async function withMockedConfigEnvironment(options, callback) {
  const originalPlatform = os.platform;
  const originalHomedir = os.homedir;
  const previousEnv = new Map(Object.keys(options.env ?? {}).map((key) => [key, process.env[key]]));

  if (options.platform) {
    os.platform = /** @type {typeof os.platform} */ (() => options.platform);
  }
  if (options.home) {
    os.homedir = /** @type {typeof os.homedir} */ (() => options.home);
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await callback();
  } finally {
    os.platform = originalPlatform;
    os.homedir = originalHomedir;
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('getBridgeDir honors BROWSER_BRIDGE_HOME override and socket path uses it', async () => {
  // Pin to a non-win32 platform: on Windows the daemon listens on a Named
  // Pipe whose name is fixed (see "getSocketPath returns a Named Pipe path on
  // win32"), so BROWSER_BRIDGE_HOME does not influence the IPC endpoint
  // there. This test continues to assert the historical Unix-socket
  // behaviour on POSIX platforms.
  await withMockedConfigEnvironment(
    {
      platform: 'linux',
      env: { [BRIDGE_HOME_ENV]: '/tmp/browser-bridge-home' },
    },
    async () => {
      assert.equal(getBridgeDir(), '/tmp/browser-bridge-home');
      assert.equal(getSocketPath(), path.join('/tmp/browser-bridge-home', 'bridge.sock'));
    }
  );
});

test('getBridgeDir resolves platform-specific defaults', async () => {
  await withMockedConfigEnvironment(
    {
      platform: 'darwin',
      home: '/Users/tester',
      env: {
        [BRIDGE_HOME_ENV]: undefined,
        LOCALAPPDATA: undefined,
        XDG_DATA_HOME: undefined,
      },
    },
    async () => {
      assert.equal(getBridgeDir(), '/Users/tester/Library/Application Support/Browser Bridge');
      assert.equal(getLauncherFilename(), 'native-host-launcher.sh');
      assert.match(getManifestInstallDir('edge'), /Microsoft Edge/);
    }
  );

  await withMockedConfigEnvironment(
    {
      platform: 'linux',
      home: '/home/tester',
      env: {
        [BRIDGE_HOME_ENV]: undefined,
        XDG_DATA_HOME: '/tmp/xdg-data',
      },
    },
    async () => {
      assert.equal(getBridgeDir(), '/tmp/xdg-data/browser-bridge');
      assert.match(getManifestInstallDir('chromium'), /chromium/);
    }
  );

  await withMockedConfigEnvironment(
    {
      platform: 'win32',
      home: 'C:\\Users\\tester',
      env: {
        [BRIDGE_HOME_ENV]: undefined,
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      },
    },
    async () => {
      assert.equal(
        getBridgeDir(),
        path.join('C:\\Users\\tester\\AppData\\Local', 'Browser Bridge')
      );
      assert.equal(getLauncherFilename(), 'native-host-launcher.cmd');
      assert.match(getManifestInstallDir('brave'), /BraveSoftware/);
    }
  );
});

test('getSocketPath returns a Named Pipe path on win32', async () => {
  await withMockedConfigEnvironment(
    {
      platform: 'win32',
      home: 'C:\\Users\\tester',
      env: {
        [BRIDGE_HOME_ENV]: undefined,
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      },
    },
    async () => {
      // On Windows the daemon listens on a Named Pipe rather than a Unix
      // domain socket file because Node's AF_UNIX bind is unreliable on
      // recent Node + Windows 11 combinations (EACCES on listen). The pipe
      // name reuses APP_NAME so it stays stable and discoverable.
      assert.equal(getSocketPath(), '\\\\.\\pipe\\com.browserbridge.browser_bridge');
    }
  );
});

test('getSocketPath uses Unix-socket file path on non-Windows platforms', async () => {
  for (const platform of /** @type {const} */ (['darwin', 'linux'])) {
    await withMockedConfigEnvironment(
      {
        platform,
        env: { [BRIDGE_HOME_ENV]: '/tmp/browser-bridge-home' },
      },
      async () => {
        assert.equal(getSocketPath(), path.join('/tmp/browser-bridge-home', 'bridge.sock'));
      }
    );
  }
});
