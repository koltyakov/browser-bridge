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
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Google',
    'Chrome',
    'NativeMessagingHosts'
  );
}
