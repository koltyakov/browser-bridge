// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { getBridgeDir } from '../../native-host/src/config.js';

/** @typedef {import('../../protocol/src/types.js').SessionState} SessionState */

const SESSION_FILE = path.join(getBridgeDir(), 'current-session.json');

/**
 * @param {SessionState} session
 * @returns {Promise<void>}
 */
export async function saveSession(session) {
  await fs.promises.mkdir(path.dirname(SESSION_FILE), { recursive: true });
  await fs.promises.writeFile(`${SESSION_FILE}`, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

/**
 * @returns {Promise<SessionState | null>}
 */
export async function loadSession() {
  try {
    const contents = await fs.promises.readFile(SESSION_FILE, 'utf8');
    return /** @type {SessionState} */ (JSON.parse(contents));
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<void>}
 */
export async function clearSession() {
  await fs.promises.rm(SESSION_FILE, { force: true });
}
