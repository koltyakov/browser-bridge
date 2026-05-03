// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  applyWindowsTcpTransportDefaults,
  BRIDGE_TCP_PORT_ENV,
  BRIDGE_HOME_ENV,
  DEFAULT_WINDOWS_TCP_PORT,
  formatBridgeTransport,
  getBridgeTcpPort,
  getBridgeTransport,
  getDaemonPidPath,
  getBridgeDir,
  getLauncherFilename,
  getManifestInstallDir,
  getSocketPath,
  SUPPORTED_BROWSERS,
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
  // Pin to Linux so the assertions stay on a stable POSIX path shape.
  await withMockedConfigEnvironment(
    {
      platform: 'linux',
      env: { [BRIDGE_HOME_ENV]: '/tmp/browser-bridge-home' },
    },
    async () => {
      assert.equal(getBridgeDir(), '/tmp/browser-bridge-home');
      assert.equal(getSocketPath(), path.join('/tmp/browser-bridge-home', 'bridge.sock'));
      assert.equal(getDaemonPidPath(), path.join('/tmp/browser-bridge-home', 'daemon.pid'));
    }
  );
});

test('getBridgeTransport falls back to socket mode when BBX_TCP_PORT is unset', async () => {
  await withMockedConfigEnvironment(
    {
      env: {
        [BRIDGE_HOME_ENV]: '/tmp/browser-bridge-home',
        [BRIDGE_TCP_PORT_ENV]: undefined,
      },
    },
    async () => {
      assert.equal(getBridgeTcpPort(), null);
      assert.deepEqual(getBridgeTransport(), {
        type: 'socket',
        socketPath: path.join('/tmp/browser-bridge-home', 'bridge.sock'),
        label: path.join('/tmp/browser-bridge-home', 'bridge.sock'),
      });
    }
  );
});

test('applyWindowsTcpTransportDefaults seeds the default Windows tcp port', async () => {
  await withMockedConfigEnvironment(
    {
      platform: 'win32',
      env: {
        [BRIDGE_HOME_ENV]: undefined,
        [BRIDGE_TCP_PORT_ENV]: undefined,
      },
    },
    async () => {
      assert.equal(applyWindowsTcpTransportDefaults(), true);
      assert.equal(process.env[BRIDGE_TCP_PORT_ENV], String(DEFAULT_WINDOWS_TCP_PORT));
      assert.deepEqual(getBridgeTransport(), {
        type: 'tcp',
        host: '127.0.0.1',
        port: DEFAULT_WINDOWS_TCP_PORT,
        label: `127.0.0.1:${DEFAULT_WINDOWS_TCP_PORT}`,
      });
    }
  );
});

test('applyWindowsTcpTransportDefaults preserves custom bridge-home socket setups', async () => {
  await withMockedConfigEnvironment(
    {
      platform: 'win32',
      env: {
        [BRIDGE_HOME_ENV]: 'C:\\tmp\\bbx-home',
        [BRIDGE_TCP_PORT_ENV]: undefined,
      },
    },
    async () => {
      assert.equal(applyWindowsTcpTransportDefaults(), false);
      assert.deepEqual(getBridgeTransport(), {
        type: 'socket',
        socketPath: path.join('C:\\tmp\\bbx-home', 'bridge.sock'),
        label: path.join('C:\\tmp\\bbx-home', 'bridge.sock'),
      });
    }
  );
});

test('getBridgeTransport returns tcp mode when BBX_TCP_PORT is set', async () => {
  await withMockedConfigEnvironment(
    {
      env: { [BRIDGE_TCP_PORT_ENV]: String(DEFAULT_WINDOWS_TCP_PORT) },
    },
    async () => {
      assert.equal(getBridgeTcpPort(), DEFAULT_WINDOWS_TCP_PORT);
      assert.deepEqual(getBridgeTransport(), {
        type: 'tcp',
        host: '127.0.0.1',
        port: DEFAULT_WINDOWS_TCP_PORT,
        label: `127.0.0.1:${DEFAULT_WINDOWS_TCP_PORT}`,
      });
      assert.equal(
        formatBridgeTransport(getBridgeTransport()),
        `127.0.0.1:${DEFAULT_WINDOWS_TCP_PORT}`
      );
    }
  );
});

test('getBridgeTcpPort rejects invalid values', async () => {
  await withMockedConfigEnvironment(
    {
      env: { [BRIDGE_TCP_PORT_ENV]: 'not-a-port' },
    },
    async () => {
      assert.throws(() => getBridgeTcpPort(), /BBX_TCP_PORT must be an integer/);
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
      assert.equal(
        getBridgeDir(),
        path.join('/Users/tester', 'Library', 'Application Support', 'Browser Bridge')
      );
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
      assert.equal(getBridgeDir(), path.join('/tmp/xdg-data', 'browser-bridge'));
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

test('getManifestInstallDir resolves every supported browser path on each platform', async () => {
  /** @type {Array<{
   *   platform: NodeJS.Platform,
   *   home: string,
   *   env: Record<string, string | undefined>,
   *   expected: Record<string, string>
   * }>} */
  const cases = [
    {
      platform: 'darwin',
      home: '/Users/tester',
      env: {
        [BRIDGE_HOME_ENV]: undefined,
        LOCALAPPDATA: undefined,
        XDG_DATA_HOME: undefined,
      },
      expected: {
        chrome: path.join(
          '/Users/tester',
          'Library',
          'Application Support',
          'Google',
          'Chrome',
          'NativeMessagingHosts'
        ),
        edge: path.join(
          '/Users/tester',
          'Library',
          'Application Support',
          'Microsoft Edge',
          'NativeMessagingHosts'
        ),
        brave: path.join(
          '/Users/tester',
          'Library',
          'Application Support',
          'BraveSoftware',
          'Brave-Browser',
          'NativeMessagingHosts'
        ),
        chromium: path.join(
          '/Users/tester',
          'Library',
          'Application Support',
          'Chromium',
          'NativeMessagingHosts'
        ),
        arc: path.join(
          '/Users/tester',
          'Library',
          'Application Support',
          'Arc',
          'User Data',
          'NativeMessagingHosts'
        ),
      },
    },
    {
      platform: 'win32',
      home: 'C:\\Users\\tester',
      env: {
        [BRIDGE_HOME_ENV]: undefined,
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
        XDG_DATA_HOME: undefined,
      },
      expected: {
        chrome: path.join(
          'C:\\Users\\tester\\AppData\\Local',
          'Google',
          'Chrome',
          'User Data',
          'NativeMessagingHosts'
        ),
        edge: path.join(
          'C:\\Users\\tester\\AppData\\Local',
          'Microsoft',
          'Edge',
          'User Data',
          'NativeMessagingHosts'
        ),
        brave: path.join(
          'C:\\Users\\tester\\AppData\\Local',
          'BraveSoftware',
          'Brave-Browser',
          'User Data',
          'NativeMessagingHosts'
        ),
        chromium: path.join(
          'C:\\Users\\tester\\AppData\\Local',
          'Chromium',
          'User Data',
          'NativeMessagingHosts'
        ),
        arc: path.join(
          'C:\\Users\\tester\\AppData\\Local',
          'Arc',
          'User Data',
          'NativeMessagingHosts'
        ),
      },
    },
    {
      platform: 'linux',
      home: '/home/tester',
      env: {
        [BRIDGE_HOME_ENV]: undefined,
        LOCALAPPDATA: undefined,
        XDG_DATA_HOME: undefined,
      },
      expected: {
        chrome: path.join('/home/tester', '.config', 'google-chrome', 'NativeMessagingHosts'),
        edge: path.join('/home/tester', '.config', 'microsoft-edge', 'NativeMessagingHosts'),
        brave: path.join(
          '/home/tester',
          '.config',
          'BraveSoftware',
          'Brave-Browser',
          'NativeMessagingHosts'
        ),
        chromium: path.join('/home/tester', '.config', 'chromium', 'NativeMessagingHosts'),
        arc: path.join('/home/tester', '.config', 'Arc', 'User Data', 'NativeMessagingHosts'),
      },
    },
  ];

  for (const testCase of cases) {
    await withMockedConfigEnvironment(testCase, async () => {
      assert.deepEqual(
        Object.fromEntries(
          SUPPORTED_BROWSERS.map((browser) => [browser, getManifestInstallDir(browser)])
        ),
        testCase.expected
      );
    });
  }
});
