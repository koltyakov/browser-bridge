// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'com.browserbridge.browser_bridge';
export const BRIDGE_HOME_ENV = 'BROWSER_BRIDGE_HOME';
export const BRIDGE_TCP_PORT_ENV = 'BBX_TCP_PORT';
export const BRIDGE_TCP_HOST_ENV = 'BBX_TCP_HOST';
export const BRIDGE_TCP_BIND_HOST_ENV = 'BBX_TCP_BIND_HOST';
export const DEFAULT_WINDOWS_TCP_PORT = 9223;
export const PROXY_CONFIG_FILENAME = 'proxy.json';

/** @typedef {{ type: 'socket', socketPath: string, label: string } | { type: 'tcp', host: string, port: number, bindHost?: string, label: string }} BridgeTransport */

/**
 * @typedef {{
 *   enabled: boolean,
 *   port: number,
 *   bindHost: string,
 *   token?: string,
 * }} BridgeProxyConfig
 */

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
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function getProxyConfigPath(env = process.env) {
  return path.join(getBridgeDir(env), PROXY_CONFIG_FILENAME);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeHost(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const host = value.trim();
  if (!host || /[\s/]/u.test(host)) {
    return null;
  }
  return host;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizePort(value) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  const raw = String(value).trim();
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || String(port) !== raw || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {BridgeProxyConfig | null}
 */
export function readProxyConfig(env = process.env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getProxyConfigPath(env), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = /** @type {Record<string, unknown>} */ (parsed);
    const port = normalizePort(record.port);
    const bindHost = normalizeHost(record.bindHost) ?? '0.0.0.0';
    if (record.enabled !== true || port === null) {
      return null;
    }
    return {
      enabled: true,
      port,
      bindHost,
      ...(typeof record.token === 'string' ? { token: record.token } : {}),
    };
  } catch {
    return null;
  }
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
export function createTcpBridgeTransport(port, host = '127.0.0.1', bindHost = host) {
  return {
    type: 'tcp',
    host,
    port,
    ...(bindHost !== host ? { bindHost } : {}),
    label: bindHost !== host ? `${host}:${port} (bind ${bindHost})` : `${host}:${port}`,
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
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function getBridgeTcpHost(env = process.env) {
  const raw = env[BRIDGE_TCP_HOST_ENV];
  if (raw == null || raw === '') {
    return '127.0.0.1';
  }
  const host = normalizeHost(raw);
  if (!host) {
    throw new Error(`${BRIDGE_TCP_HOST_ENV} must be a hostname or IP address.`);
  }
  return host;
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string | null}
 */
export function getBridgeTcpBindHost(env = process.env) {
  const raw = env[BRIDGE_TCP_BIND_HOST_ENV];
  if (raw == null || raw === '') {
    return null;
  }
  const host = normalizeHost(raw);
  if (!host) {
    throw new Error(`${BRIDGE_TCP_BIND_HOST_ENV} must be a hostname or IP address.`);
  }
  return host;
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
  if (readProxyConfig(env)) {
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
    const host = getBridgeTcpHost(env);
    return createTcpBridgeTransport(tcpPort, host, getBridgeTcpBindHost(env) ?? host);
  }

  const proxyConfig = readProxyConfig(env);
  if (proxyConfig) {
    return createTcpBridgeTransport(proxyConfig.port, '127.0.0.1', proxyConfig.bindHost);
  }

  return createSocketBridgeTransport(getSocketPath(env));
}

/**
 * @param {BridgeTransport} [transport=getBridgeTransport()]
 * @returns {import('node:net').ListenOptions | string}
 */
export function getBridgeListenTarget(transport = getBridgeTransport()) {
  if (transport.type === 'tcp') {
    return { host: transport.bindHost ?? transport.host, port: transport.port };
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
 * @returns {SupportedBrowser}
 */
export function getDefaultBrowser() {
  return os.platform() === 'linux' ? 'chromium' : 'chrome';
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 * @returns {string}
 */
function getLinuxConfigHome(env, home) {
  if (env.CHROME_CONFIG_HOME) {
    return env.CHROME_CONFIG_HOME;
  }
  if (env.XDG_CONFIG_HOME) {
    return env.XDG_CONFIG_HOME;
  }
  return path.join(home, '.config');
}

/**
 * Return the native messaging host manifest install directory for the given
 * browser on the current platform.
 *
 * @param {SupportedBrowser} [browser=getDefaultBrowser()]
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function getManifestInstallDir(browser = getDefaultBrowser(), env = process.env) {
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
    const winBase = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
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
  const linuxConfigHome = getLinuxConfigHome(env, home);
  const chromiumSnapProfile = path.join(home, 'snap', 'chromium', 'common', 'chromium');
  const useChromiumSnapProfile =
    !env.CHROME_CONFIG_HOME && !env.XDG_CONFIG_HOME && fs.existsSync(chromiumSnapProfile);
  const linuxPaths = {
    chrome: path.join(linuxConfigHome, 'google-chrome', 'NativeMessagingHosts'),
    edge: path.join(linuxConfigHome, 'microsoft-edge', 'NativeMessagingHosts'),
    brave: path.join(linuxConfigHome, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    chromium: useChromiumSnapProfile
      ? path.join(chromiumSnapProfile, 'NativeMessagingHosts')
      : path.join(linuxConfigHome, 'chromium', 'NativeMessagingHosts'),
    arc: path.join(linuxConfigHome, 'Arc', 'User Data', 'NativeMessagingHosts'),
  };
  return linuxPaths[browser] ?? linuxPaths.chrome;
}
