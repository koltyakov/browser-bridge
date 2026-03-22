// @ts-check

import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'com.browserbridge.browser_bridge';

/**
 * The published Chrome Web Store extension ID.
 * TODO: replace with final ID once published.
 *
 * @type {string}
 */
export const PUBLISHED_EXTENSION_ID = 'niaidbpnkbfbjgdfieabpmlomilpdipn';

/**
 * @returns {string}
 */
export function getBridgeDir() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'browser-bridge');
}

/**
 * @returns {string}
 */
export function getSocketPath() {
  return path.join(getBridgeDir(), 'bridge.sock');
}

/**
 * @typedef {'chrome' | 'edge' | 'brave' | 'chromium'} SupportedBrowser
 */

/**
 * Supported browser identifiers, in display order.
 *
 * @type {SupportedBrowser[]}
 */
export const SUPPORTED_BROWSERS = ['chrome', 'edge', 'brave', 'chromium'];

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
      chromium: path.join(macBase, 'Chromium', 'NativeMessagingHosts')
    };
    return macPaths[browser] ?? macPaths.chrome;
  }

  if (platform === 'win32') {
    const winBase = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const winPaths = {
      chrome: path.join(winBase, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts'),
      edge: path.join(winBase, 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts'),
      brave: path.join(winBase, 'BraveSoftware', 'Brave-Browser', 'User Data', 'NativeMessagingHosts'),
      chromium: path.join(winBase, 'Chromium', 'User Data', 'NativeMessagingHosts')
    };
    return winPaths[browser] ?? winPaths.chrome;
  }

  // Linux / others
  const linuxPaths = {
    chrome: path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
    edge: path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts'),
    brave: path.join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    chromium: path.join(home, '.config', 'chromium', 'NativeMessagingHosts')
  };
  return linuxPaths[browser] ?? linuxPaths.chrome;
}
