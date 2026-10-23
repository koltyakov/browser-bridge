// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { format } from 'oxfmt';

/** @typedef {{key: string, goos: string, goarch: string, asset: string, runner: string, unixPatterns?: string[], windowsArch?: string}} NativePlatform */
/** @typedef {{key: string, macDir: string, windowsDir: string, linuxDir: string, registry: string}} BrowserTarget */
/** @typedef {{hostName: string, extensionId: string, maxBinaryBytes: number, platforms: NativePlatform[], browsers: BrowserTarget[]}} InstallTargets */

/** @param {unknown} input @returns {asserts input is InstallTargets} */
export function validateInstallTargets(input) {
  assert(input && typeof input === 'object');
  const source = /** @type {InstallTargets} */ (input);
  assert.match(source.hostName, /^[a-z][a-z0-9_.]+$/u);
  assert.match(source.extensionId, /^[a-p]{32}$/u);
  assert(Number.isSafeInteger(source.maxBinaryBytes) && source.maxBinaryBytes > 0);
  assert(Array.isArray(source.platforms) && source.platforms.length > 0);
  assert(Array.isArray(source.browsers) && source.browsers.length > 0);
  for (const field of ['key', 'asset']) {
    const values = source.platforms.map((entry) => entry[/** @type {'key' | 'asset'} */ (field)]);
    assert.equal(new Set(values).size, values.length, `Duplicate platform ${field}`);
  }
  assert.equal(new Set(source.browsers.map((entry) => entry.key)).size, source.browsers.length);
  for (const entry of source.platforms) {
    for (const value of [
      entry.key,
      entry.goos,
      entry.goarch,
      entry.asset,
      entry.runner,
      ...(entry.unixPatterns ?? []),
      ...(entry.windowsArch ? [entry.windowsArch] : []),
    ])
      assert.match(value, /^[A-Za-z0-9_.:-]+$/u);
    assert(entry.goos === 'windows' ? entry.windowsArch : entry.unixPatterns?.length);
  }
  for (const entry of source.browsers) {
    assert.match(entry.key, /^[a-z]+$/u);
    for (const value of [entry.macDir, entry.windowsDir, entry.linuxDir, entry.registry]) {
      assert(
        typeof value === 'string' &&
          value.length > 0 &&
          !value.includes('..') &&
          !/^[\\/]/u.test(value)
      );
    }
  }
}

/** @param {boolean} check @param {string} [root] @returns {Promise<void>} */
export async function generateInstallTargets(
  check,
  root = fileURLToPath(new URL('../', import.meta.url))
) {
  const source = /** @type {unknown} */ (
    JSON.parse(await fs.readFile(path.join(root, 'protocol/install-targets.json'), 'utf8'))
  );
  validateInstallTargets(source);
  const quote = JSON.stringify;
  /** @param {string} filename @param {string} content */
  async function write(filename, content) {
    const destination = path.join(root, filename);
    const previous = await fs.readFile(destination, 'utf8').catch(() => '');
    if (check) assert.equal(previous, content, `${filename} is stale. Run make generate-protocol.`);
    else if (previous !== content) await fs.writeFile(destination, content);
  }
  /** @param {string} filename @param {string} marker @param {string} body */
  async function block(filename, marker, body) {
    const text = await fs.readFile(path.join(root, filename), 'utf8');
    const expression = new RegExp(
      `(^[ \\t]*# BEGIN GENERATED ${marker}\\n)[\\s\\S]*?(^[ \\t]*# END GENERATED ${marker})`,
      'mgu'
    );
    assert(expression.test(text), `Missing generated block ${filename}/${marker}`);
    await write(
      filename,
      text.replace(expression, (_all, begin, end) => `${begin}${body}\n${end}`)
    );
  }
  const nativeTargets = Object.fromEntries(
    source.platforms.map((entry) => [entry.key, entry.asset])
  );
  const js = `// @ts-check\n// Code generated from protocol/install-targets.json. DO NOT EDIT.\n/** @typedef {{key: string, goos: string, goarch: string, asset: string, runner: string, unixPatterns?: string[], windowsArch?: string}} NativePlatform */\n/** @type {readonly NativePlatform[]} */\nexport const nativePlatforms = Object.freeze(${quote(source.platforms)});\n/** @type {Readonly<Record<string, string>>} */\nexport const nativeTargets = Object.freeze(${quote(nativeTargets)});\nexport const nativeMaxBytes = ${source.maxBinaryBytes};\n`;
  // Formatting generated JS uses the same pinned formatter as checked-in source.
  const formatted = await format('install-targets.js', js, {
    singleQuote: true,
    tabWidth: 2,
    semi: true,
    trailingComma: 'es5',
  });
  assert.equal(formatted.errors.length, 0);
  await write('packages/npm/src/install-targets.js', formatted.code);
  const go = `// Code generated from protocol/install-targets.json. DO NOT EDIT.\npackage bridge\nconst hostName = ${quote(source.hostName)}\nconst publishedExtensionID = ${quote(source.extensionId)}\nconst nativeMaxBytes = ${source.maxBinaryBytes}\nvar browserRegistry = []browserDefinition{${source.browsers.map((entry) => `{key:${quote(entry.key)}, macDir:${quote(entry.macDir)}, windowsDir:${quote(entry.windowsDir)}, linuxDir:${quote(entry.linuxDir)}, registry:${quote(entry.registry)}}`).join(',')},}\nvar nativePlatformRegistry = []nativePlatformDefinition{${source.platforms.map((entry) => `{key:${quote(entry.key)}, goos:${quote(entry.goos)}, goarch:${quote(entry.goarch)}, asset:${quote(entry.asset)}}`).join(',')},}\n`;
  await write(
    'internal/bridge/install_targets.gen.go',
    execFileSync('gofmt', [], { input: go, encoding: 'utf8' })
  );
  await write(
    'packages/extension/src/install-targets.ts',
    `// Code generated from protocol/install-targets.json. DO NOT EDIT.\nexport const PUBLISHED_EXTENSION_ID = '${source.extensionId}';\nexport const NATIVE_APP_NAME = '${source.hostName}';\n`
  );
  await block(
    'scripts/install.sh',
    'EXTENSION_ID',
    `extension_id="\${BBX_EXTENSION_ID:-${source.extensionId}}"`
  );
  await block(
    'scripts/install.sh',
    'BROWSERS',
    `case "$browser" in ${source.browsers.map((entry) => entry.key).join('|')}) ;; *) echo 'Unsupported browser' >&2; exit 1;; esac`
  );
  await block(
    'scripts/install.sh',
    'PLATFORMS',
    `case "$(uname -s):$(uname -m)" in\n${source.platforms
      .filter((entry) => entry.unixPatterns)
      .map((entry) => `  ${entry.unixPatterns?.join('|')}) asset='${entry.asset}';;`)
      .join('\n')}\n  *) echo 'Unsupported OS or architecture' >&2; exit 1;;\nesac`
  );
  await block(
    'scripts/install.ps1',
    'PARAMETERS',
    `  [string]$ExtensionId = '${source.extensionId}',\n  [ValidateSet(${source.browsers.map((entry) => `'${entry.key}'`).join(', ')})]`
  );
  await block(
    'scripts/install.ps1',
    'PLATFORMS',
    `switch ($nativeArch) {\n${source.platforms
      .filter((entry) => entry.windowsArch)
      .map((entry) => `  '${entry.windowsArch}' { $asset = '${entry.asset}'; break }`)
      .join('\n')}\n  default { throw 'Unsupported Windows architecture' }\n}`
  );
  await block(
    '.github/workflows/native.yml',
    'PLATFORMS',
    source.platforms
      .map((entry) => `          - os: ${entry.runner}\n            asset: ${entry.asset}`)
      .join('\n')
  );
}
