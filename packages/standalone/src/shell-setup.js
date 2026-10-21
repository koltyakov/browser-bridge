// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getStandaloneRoot } from './runtime.js';
import { escapeSingleQuotes } from '../../native-host/src/install-manifest.js';

const execFileAsync = promisify(execFile);
const START = '# >>> Browser Bridge companion >>>';
const END = '# <<< Browser Bridge companion <<<';

/** @typedef {{ path: string, before: string | null, after: string }} ShellEdit */

/** @param {string} filename @returns {Promise<string | null>} */
async function readOptional(filename) {
  try {
    return await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** @param {string} raw @param {string} directory @returns {string} */
export function addCompanionPath(raw, directory) {
  const block = `${START}\ncase ":$PATH:" in\n  *':'\u0027${escapeSingleQuotes(directory)}\u0027':'*) ;;\n  *) export PATH='${escapeSingleQuotes(directory)}':"$PATH" ;;\nesac\n${END}\n`;
  const start = raw.indexOf(START);
  if (start !== -1) {
    const end = raw.indexOf(END, start);
    if (end === -1)
      throw new Error(
        'An incomplete Browser Bridge PATH block needs repair before setup can continue.'
      );
    const after = end + END.length;
    return raw.slice(0, start) + block + raw.slice(raw[after] === '\n' ? after + 1 : after);
  }
  return `${raw}${raw.endsWith('\n') || !raw ? '' : '\n'}${block}`;
}

/** @returns {Promise<ShellEdit[]>} */
export async function planShellSetup() {
  if (process.platform === 'win32' || process.env.BBX_NO_PATH === '1') return [];
  const home = os.homedir();
  const zshHome = process.env.ZDOTDIR || home;
  const bashProfile = path.join(home, '.bash_profile');
  const bashLogin = path.join(home, '.bash_login');
  const loginProfile =
    (await readOptional(bashProfile)) !== null
      ? bashProfile
      : (await readOptional(bashLogin)) !== null
        ? bashLogin
        : path.join(home, '.profile');
  const filenames = [
    loginProfile,
    path.join(home, '.bashrc'),
    path.join(zshHome, '.zprofile'),
    path.join(zshHome, '.zshrc'),
  ];
  /** @type {ShellEdit[]} */
  const edits = [];
  const seen = new Set();
  for (let filename of filenames) {
    try {
      filename = await fs.realpath(filename);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Do not replace a dangling dotfile symlink with a regular file.
      const link = await fs.readlink(filename).catch(() => null);
      if (link) throw new Error(`Shell settings link is broken: ${filename}`);
    }
    if (seen.has(filename)) continue;
    seen.add(filename);
    const before = await readOptional(filename);
    const after = addCompanionPath(before ?? '', getStandaloneRoot());
    if (before !== after) edits.push({ path: filename, before, after });
  }
  return edits;
}

/** @typedef {{ value: string, type: 'REG_SZ' | 'REG_EXPAND_SZ' } | null} WindowsPath */

/** @returns {Promise<WindowsPath>} */
export async function readWindowsUserPath() {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path']);
    const match = /\b(REG_SZ|REG_EXPAND_SZ)\s+([^\r\n]*)/.exec(stdout);
    if (!match) throw new Error('Could not read the existing Windows user PATH.');
    return { value: match[2], type: /** @type {'REG_SZ' | 'REG_EXPAND_SZ'} */ (match[1]) };
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
}

/** @param {WindowsPath} value @returns {Promise<void>} */
export async function writeWindowsUserPath(value) {
  if (value === null)
    await execFileAsync('reg.exe', ['delete', 'HKCU\\Environment', '/v', 'Path', '/f']).catch(
      () => {}
    );
  else
    await execFileAsync('reg.exe', [
      'add',
      'HKCU\\Environment',
      '/v',
      'Path',
      '/t',
      value.type,
      '/d',
      value.value,
      '/f',
    ]);
}

/** @param {WindowsPath} previous @returns {Promise<void>} */
export async function installWindowsPath(previous) {
  const root = getStandaloneRoot();
  const remaining = (previous?.value ?? '')
    .split(';')
    .filter((part) => part && part.replace(/\\$/, '').toLowerCase() !== root.toLowerCase());
  await writeWindowsUserPath({
    value: [root, ...remaining].join(';'),
    type: previous?.type ?? 'REG_EXPAND_SZ',
  });
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const script = `Add-Type -Namespace BBX -Name EnvironmentNotify -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'; $result = [UIntPtr]::Zero; [void][BBX.EnvironmentNotify]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)`;
  await execFileAsync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 10_000, windowsHide: true }
  ).catch(() => {});
}
