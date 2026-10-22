// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * Hash native runtime sources and embedded assets, including uncommitted edits.
 * Paths are relative and sorted so checkout location and mtimes do not affect the ID.
 * @param {string} [root]
 * @returns {string}
 */
export function nativeBuildHash(root = repositoryRoot) {
  const files = ['go.mod', 'go.sum'];
  /** @param {string} directory */
  function collectSources(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== 'testdata') collectSources(relative);
      else if (entry.isFile() && entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
        files.push(relative);
      }
    }
  }
  collectSources('cmd');
  collectSources('internal');
  files.push('internal/bridge/generated/catalog.json', 'internal/bridge/assets/skills.bundle');
  const hash = createHash('sha256');
  for (const relative of files.sort()) {
    const bytes = fs.readFileSync(path.join(root, relative));
    hash.update(`${relative}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex').slice(0, 8);
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  process.stdout.write(`${nativeBuildHash()}\n`);
}
