// @ts-check

import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'com.browserbridge.browser_bridge';
export const BRIDGE_HOME_ENV = 'BROWSER_BRIDGE_HOME';
export const BRIDGE_TCP_PORT_ENV = 'BBX_TCP_PORT';
export const DEFAULT_WINDOWS_TCP_PORT = 9223;

/** @typedef {{ type: 'socket', socketPath: string, label: string } | { type: 'tcp', host: string, port: number, label: string }} BridgeTransport */

/**
 * The official Chrome Web Store extension ID used when callers do not provide
 * an explicit override.
 *
 * @type {string}
 */
export const PUBLISHED_EXTENSION_ID = 'jjjkmmcdkpcgamlopogicbnnhdgebhie';

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function getBridgeDir(env = process.env) {
  const override = env[BRIDGE_HOME_ENV];
  if (override) {
    return override;
  }

  const home = os.homedir();
  const platform = os.platform();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Browser Bridge');
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'Browser Bridge');
  }

  const xdgDataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdgDataHome, 'browser-bridge');
}

/**
 * Resolve the IPC endpoint the daemon listens on and the CLI / native host
 * connect to. On Windows we use a Named Pipe by default because Node's AF_UNIX
 * support fails with EACCES on listen() under recent Node + Windows 11
 * combinations, while Named Pipes are the historical and reliable Windows IPC
 * mechanism. An explicit bridge-home override keeps the legacy socket path so
 * callers can opt into custom test or compatibility setups.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function getSocketPath(env = process.env) {
  if (os.platform() === 'win32' && !env[BRIDGE_HOME_ENV]) {
    return `\\\\.\\pipe\\${APP_NAME}`;
  }
  return path.join(getBridgeDir(env), 'bridge.sock');
}

/**
 * @param {string} socketPath
 * @returns {BridgeTransport}
 */
export function createSocketBridgeTransport(socketPath) {
  return {
    type: 'socket',
    socketPath,
    label: socketPath,
  };
}

/**
 * @param {number} port
 * @param {string} [host='127.0.0.1']
 * @returns {BridgeTransport}
 */
export function createTcpBridgeTransport(port, host = '127.0.0.1') {
  return {
    type: 'tcp',
    host,
    port,
    label: `${host}:${port}`,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {number | null}
 */
export function getBridgeTcpPort(env = process.env) {
  const raw = env[BRIDGE_TCP_PORT_ENV];
  if (raw == null || raw === '') {
    return null;
  }

  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || String(port) !== String(raw).trim() || port < 1 || port > 65535) {
    throw new Error(
      `${BRIDGE_TCP_PORT_ENV} must be an integer between 1 and 65535 (got ${JSON.stringify(raw)}).`
    );
  }

  return port;
}

/**
 * Align Windows CLI/daemon entrypoints with the installed native-host launcher,
 * which uses TCP by default. Preserve explicit overrides and custom bridge-home
 * test setups that rely on the socket transport.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function applyWindowsTcpTransportDefaults(env = process.env) {
  if (os.platform() !== 'win32') {
    return false;
  }
  if (env[BRIDGE_TCP_PORT_ENV] != null && env[BRIDGE_TCP_PORT_ENV] !== '') {
    return false;
  }
  if (env[BRIDGE_HOME_ENV]) {
    return false;
  }

  env[BRIDGE_TCP_PORT_ENV] = String(DEFAULT_WINDOWS_TCP_PORT);
  return true;
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {BridgeTransport}
 */
export function getBridgeTransport(env = process.env) {
  const tcpPort = getBridgeTcpPort(env);
  if (tcpPort !== null) {
    return createTcpBridgeTransport(tcpPort);
  }

  return createSocketBridgeTransport(getSocketPath(env));
}

/**
 * @param {BridgeTransport} [transport=getBridgeTransport()]
 * @returns {import('node:net').ListenOptions | string}
 */
export function getBridgeListenTarget(transport = getBridgeTransport()) {
  if (transport.type === 'tcp') {
    return { host: transport.host, port: transport.port };
  }
  return transport.socketPath;
}

/**
 * @param {BridgeTransport} [transport=getBridgeTransport()]
 * @returns {string}
 */
export function formatBridgeTransport(transport = getBridgeTransport()) {
  return transport.label;
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function getDaemonPidPath(env = process.env) {
  return path.join(getBridgeDir(env), 'daemon.pid');
}

/**
 * @returns {string}
 */
export function getLauncherFilename() {
  return os.platform() === 'win32' ? 'native-host-launcher.cmd' : 'native-host-launcher.sh';
}

/**
 * @typedef {'chrome' | 'edge' | 'brave' | 'chromium' | 'arc'} SupportedBrowser
 */

/**
 * Supported browser identifiers, in display order.
 *
 * @type {SupportedBrowser[]}
 */
export const SUPPORTED_BROWSERS = ['chrome', 'edge', 'brave', 'chromium', 'arc'];

/**
 * Return the native messaging host manifest install directory for the given
 * browser on the current platform.
 *
 * @param {SupportedBrowser} [browser='chrome']
 * @returns {string}
 */
export function getManifestInstallDir(browser = 'chrome') {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === 'darwin') {
    const macBase = path.join(home, 'Library', 'Application Support');
    const macPaths = {
      chrome: path.join(macBase, 'Google', 'Chrome', 'NativeMessagingHosts'),
      edge: path.join(macBase, 'Microsoft Edge', 'NativeMessagingHosts'),
      brave: path.join(macBase, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      chromium: path.join(macBase, 'Chromium', 'NativeMessagingHosts'),
      arc: path.join(macBase, 'Arc', 'User Data', 'NativeMessagingHosts'),
    };
    return macPaths[browser] ?? macPaths.chrome;
  }

  if (platform === 'win32') {
    const winBase = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const winPaths = {
      chrome: path.join(winBase, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts'),
      edge: path.join(winBase, 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts'),
      brave: path.join(
        winBase,
        'BraveSoftware',
        'Brave-Browser',
        'User Data',
        'NativeMessagingHosts'
      ),
      chromium: path.join(winBase, 'Chromium', 'User Data', 'NativeMessagingHosts'),
      arc: path.join(winBase, 'Arc', 'User Data', 'NativeMessagingHosts'),
    };
    return winPaths[browser] ?? winPaths.chrome;
  }

  // Linux / others
  const linuxPaths = {
    chrome: path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
    edge: path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts'),
    brave: path.join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    chromium: path.join(home, '.config', 'chromium', 'NativeMessagingHosts'),
    arc: path.join(home, '.config', 'Arc', 'User Data', 'NativeMessagingHosts'),
  };
  return linuxPaths[browser] ?? linuxPaths.chrome;
}
