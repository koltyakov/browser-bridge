#!/usr/bin/env node
// @ts-check
import fs from 'node:fs/promises';

/** @type {Record<string, {minimum: number, total: number, covered: number}>} */
const packages = {
  'github.com/koltyakov/browser-bridge/internal/bridge': { minimum: 68, total: 0, covered: 0 },
  'github.com/koltyakov/browser-bridge/internal/protocol': { minimum: 85, total: 0, covered: 0 },
};
const filename = process.argv[2] ?? 'dist/coverage/go-unit.out';
let profile;
try {
  profile = await fs.readFile(filename, 'utf8');
} catch (cause) {
  throw new Error(`Cannot read Go coverage at ${filename}. Run make test-go first.`, { cause });
}
const [mode, ...lines] = profile.trim().split(/\r?\n/);
if (!/^mode: (?:set|count|atomic)$/.test(mode)) throw new Error('Invalid Go coverage mode.');
for (const line of lines) {
  const match = /^(.*):\d+\.\d+,\d+\.\d+ (\d+) (\d+)$/.exec(line);
  if (!match) throw new Error(`Invalid Go coverage record: ${line}`);
  const name = match[1].slice(0, match[1].lastIndexOf('/'));
  const entry = packages[name];
  if (!entry) continue;
  const statements = Number(match[2]);
  entry.total += statements;
  if (Number(match[3]) > 0) entry.covered += statements;
}
for (const [name, entry] of Object.entries(packages)) {
  const percent = entry.total > 0 ? (100 * entry.covered) / entry.total : 0;
  console.log(`${name}: ${percent.toFixed(2)}% statements; minimum ${entry.minimum}%`);
  if (entry.total === 0 || percent < entry.minimum) process.exitCode = 1;
}
