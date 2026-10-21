// @ts-check
import fs from 'node:fs/promises';
import { applyEdits, modify, parse } from 'jsonc-parser';
import {
  getMcpConfigPaths,
  getMcpConfigShapeForPath,
  MCP_CLIENT_NAMES,
} from '../../agent-client/src/mcp-config.js';

/** @typedef {{ path: string, before: string, after: string }} ConfigEdit */

/**
 * Only rewrite recognizable local entrypoints. Keep flags, remote destinations,
 * environment variables, disabled state and unrelated servers exactly as configured.
 * @param {string[]} command
 * @param {string} launcher
 * @returns {string[] | null}
 */
export function migrateCommand(command, launcher) {
  const first = command[0]?.replaceAll('\\', '/');
  if (!first) return null;
  const name = first.slice(first.lastIndexOf('/') + 1).toLowerCase();
  if (/^bbx(?:\.exe|\.cmd)?$/.test(name)) return [launcher, ...command.slice(1)];
  if (/^bbx-mcp(?:\.exe|\.cmd)?$/.test(name))
    return [launcher, 'mcp', 'serve', ...command.slice(1)];
  if (/^(?:node|bun)(?:\.exe)?$/.test(name)) {
    const script = command[1]?.replaceAll('\\', '/');
    if (script?.endsWith('/agent-client/src/cli.js')) return [launcher, ...command.slice(2)];
    if (script?.endsWith('/mcp-server/src/bin.js'))
      return [launcher, 'mcp', 'serve', ...command.slice(2)];
  }
  return null;
}

/**
 * Plan changes before touching any file. Invalid configs abort migration rather
 * than quietly losing an existing agent connection.
 * @param {string} launcher
 * @param {string[]} [projects]
 * @returns {Promise<ConfigEdit[]>}
 */
export async function planMcpMigration(launcher, projects = []) {
  /** @type {ConfigEdit[]} */
  const edits = [];
  const seen = new Set();
  for (const client of MCP_CLIENT_NAMES) {
    for (const scope of [{ global: true }, ...projects.map((cwd) => ({ global: false, cwd }))]) {
      for (const filename of await getMcpConfigPaths(client, scope)) {
        if (seen.has(filename)) continue;
        seen.add(filename);
        let before;
        try {
          before = await fs.readFile(filename, 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        let after = before;
        if (client === 'codex') {
          after = migrateCodexConfig(before, launcher);
        } else {
          // Only parse files that mention our entry. Unrelated JSONC files are left alone.
          if (!before.includes('browser-bridge')) continue;
          /** @type {import('jsonc-parser').ParseError[]} */
          const errors = [];
          const parsed =
            /** @type {Record<string, Record<string, Record<string, unknown>>> | null} */ (
              parse(before, errors, { allowTrailingComma: true })
            );
          if (errors.length)
            throw new Error(
              `Cannot migrate invalid agent settings: ${filename}. Fix the configuration and run setup again.`
            );
          const key = getMcpConfigShapeForPath(client, filename).key;
          const entry = parsed?.[key]?.['browser-bridge'];
          if (
            !entry ||
            typeof entry !== 'object' ||
            (entry.args !== undefined && !Array.isArray(entry.args))
          )
            continue;
          const command = Array.isArray(entry.command)
            ? entry.command
            : [entry.command, ...(entry.args ?? [])];
          if (!command.every((/** @type {unknown} */ value) => typeof value === 'string')) continue;
          const migrated = migrateCommand(/** @type {string[]} */ (command), launcher);
          if (!migrated || JSON.stringify(command) === JSON.stringify(migrated)) continue;
          const formattingOptions = { insertSpaces: true, tabSize: 2 };
          after = applyEdits(
            before,
            modify(
              before,
              [key, 'browser-bridge', 'command'],
              Array.isArray(entry.command) ? migrated : migrated[0],
              { formattingOptions }
            )
          );
          if (!Array.isArray(entry.command))
            after = applyEdits(
              after,
              modify(after, [key, 'browser-bridge', 'args'], migrated.slice(1), {
                formattingOptions,
              })
            );
        }
        if (after !== before) {
          const destination = await fs.realpath(filename);
          if (destination !== filename && seen.has(destination)) continue;
          seen.add(destination);
          edits.push({ path: destination, before, after });
        }
      }
    }
  }
  return edits;
}

/** @param {string} raw @param {string} launcher @returns {string} */
export function migrateCodexConfig(raw, launcher) {
  // Existing bbx config needs only its command changed. Leave TOML options and
  // nested env tables intact, and avoid pretending to parse arbitrary TOML.
  return raw.replace(
    /(^\[mcp_servers\.(?:"browser-bridge"|browser-bridge)\][^\n]*\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/gm,
    (section, header, body) => {
      const match = /^command\s*=\s*"([^"\n]+)"\s*$/m.exec(body);
      if (!match || !/^bbx(?:\.exe|\.cmd)?$/.test(match[1].split(/[\\/]/).at(-1) ?? ''))
        return section;
      return header + body.replace(/^command\s*=.*$/m, `command = ${JSON.stringify(launcher)}`);
    }
  );
}
