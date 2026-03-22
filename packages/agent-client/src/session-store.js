// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { getBridgeDir } from '../../native-host/src/config.js';

/** @typedef {import('../../protocol/src/types.js').SessionState} SessionState */

/**
 * Lazily compute the session file path so that CODEX_HOME overrides set after
 * module load (e.g. in tests) are respected.
 *
 * @returns {string}
 */
function getSessionFile() {
  return path.join(getBridgeDir(), 'current-session.json');
}

/**
 * @param {SessionState} session
 * @returns {Promise<void>}
 */
export async function saveSession(session) {
  const sessionFile = getSessionFile();
  await fs.promises.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.promises.writeFile(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

/**
 * @returns {Promise<SessionState | null>}
 */
export async function loadSession() {
  try {
    const contents = await fs.promises.readFile(getSessionFile(), 'utf8');
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    // Only extract known session fields to prevent prototype pollution
    const { sessionId, tabId, origin, expiresAt, capabilities } = parsed;
    if (typeof sessionId !== 'string' || typeof tabId !== 'number') {
      return null;
    }
    return /** @type {SessionState} */ ({ sessionId, tabId, origin, expiresAt, capabilities });
  } catch (err) {
    // Distinguish corruption from a missing file so callers can log if needed.
    const code = /** @type {any} */ (err)?.code;
    if (code !== 'ENOENT') {
      // JSON parse error or unexpected I/O - session file may be corrupted.
      process.stderr.write(`[bbx] Warning: Failed to load session (${code || 'PARSE_ERROR'}). Run 'bbx request-access' to create a new one.\n`);
    }
    return null;
  }
}

/**
 * @returns {Promise<void>}
 */
export async function clearSession() {
  await fs.promises.rm(getSessionFile(), { force: true });
}
