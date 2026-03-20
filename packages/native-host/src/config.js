// @ts-check

import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'com.codex.browser_bridge';

/**
 * @returns {string}
 */
export function getBridgeDir() {
  return path.join(os.homedir(), '.codex', 'browser-bridge');
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
export function getManifestInstallDir() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      'NativeMessagingHosts'
    );
  }
  if (platform === 'win32') {
    // Windows uses registry, but manifest file goes here by convention
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Google',
      'Chrome',
      'User Data',
      'NativeMessagingHosts'
    );
  }
  // Linux / others
  return path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
}
