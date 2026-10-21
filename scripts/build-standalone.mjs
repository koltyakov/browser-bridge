// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const target =
  process.argv[2] ||
  `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}${process.arch === 'x64' && process.platform !== 'darwin' ? '-baseline' : ''}`;
const supported = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64-baseline',
  'bun-linux-arm64',
  'bun-windows-x64-baseline',
];
if (!supported.includes(target))
  throw new Error(`Unsupported target ${target}. Choose ${supported.join(', ')}`);
/** @type {Record<string, string>} */
const skills = {};
/** @param {string} directory */
async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(filename);
    else
      skills[path.relative('skills/browser-bridge', filename).split(path.sep).join('/')] =
        await fs.readFile(filename, 'utf8');
  }
}
await collect('skills/browser-bridge');
await fs.mkdir('dist/standalone', { recursive: true });
const output = `dist/standalone/bbx-${target.slice(4)}${target.includes('windows') ? '.exe' : ''}`;
// Keep embedded assets out of command-line arguments, which are limited to
// 32 KiB on Windows. The generated module is compiled into the executable.
const entry = `dist/standalone/entry-${target}.mjs`;
await fs.writeFile(
  entry,
  `globalThis.BBX_BUILD = ${JSON.stringify({ version: pkg.version, target, skills, updatePublicKey: process.env.BBX_UPDATE_PUBLIC_KEY || '' })};\nawait import('../../packages/standalone/src/entry.js');\n`
);
try {
  execFileSync(
    'bun',
    ['build', '--compile', `--target=${target}`, '--minify', '--outfile', output, entry],
    { stdio: 'inherit' }
  );
} finally {
  await fs.rm(entry, { force: true });
}
console.log(`Built ${output}`);
