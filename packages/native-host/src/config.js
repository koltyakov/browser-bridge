// @ts-check

import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'com.browserbridge.browser_bridge';
export const BRIDGE_HOME_ENV = 'BROWSER_BRIDGE_HOME';

/**
 * The official Chrome Web Store extension ID used when callers do not provide
 * an explicit override.
 *
 * @type {string}
 */
export const PUBLISHED_EXTENSION_ID = 'ahhmghheecmambjebhfjkngdggghbkno';

/**
 * @returns {string}
 */
export function getBridgeDir() {
  const override = process.env[BRIDGE_HOME_ENV];
  if (override) {
    return override;
  }

  const home = os.homedir();
  const platform = os.platform();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Browser Bridge');
  }

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'Browser Bridge');
  }

  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdgDataHome, 'browser-bridge');
}

/**
 * @returns {string}
 */
export function getSocketPath() {
  return path.join(getBridgeDir(), 'bridge.sock');
}

/**
 * @returns {string}
 */
export function getLauncherFilename() {
  return os.platform() === 'win32'
    ? 'native-host-launcher.cmd'
    : 'native-host-launcher.sh';
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
      arc: path.join(macBase, 'Arc', 'User Data', 'NativeMessagingHosts')
    };
    return macPaths[browser] ?? macPaths.chrome;
  }

  if (platform === 'win32') {
    const winBase = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const winPaths = {
      chrome: path.join(winBase, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts'),
      edge: path.join(winBase, 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts'),
      brave: path.join(winBase, 'BraveSoftware', 'Brave-Browser', 'User Data', 'NativeMessagingHosts'),
      chromium: path.join(winBase, 'Chromium', 'User Data', 'NativeMessagingHosts'),
      arc: path.join(winBase, 'Arc', 'User Data', 'NativeMessagingHosts')
    };
    return winPaths[browser] ?? winPaths.chrome;
  }

  // Linux / others
  const linuxPaths = {
    chrome: path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
    edge: path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts'),
    brave: path.join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    chromium: path.join(home, '.config', 'chromium', 'NativeMessagingHosts'),
    arc: path.join(home, '.config', 'Arc', 'User Data', 'NativeMessagingHosts')
  };
  return linuxPaths[browser] ?? linuxPaths.chrome;
}
