import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { parse } from '@babel/parser';
import { parseHTML } from 'linkedom';
import { extensionFile, loadExtensionModule } from '../../../tests/_helpers/extensionBuild.ts';

const root = extensionFile('');

test('development build publishes a complete stamp matching its loaded health digest', async () => {
  const buildInfo =
    await loadExtensionModule<typeof import('../src/build-info.js')>('src/build-info.js');
  assert.equal(buildInfo.DEVELOPMENT_AUTO_RELOAD, true);
  assert.match(buildInfo.SOURCE_DIGEST ?? '', /^[a-f0-9]{64}$/);
  const stamp = JSON.parse(
    await readFile(new URL('development-build.json', root), 'utf8')
  ) as unknown;
  assert.deepEqual(stamp, {
    formatVersion: 1,
    complete: true,
    sourceDigest: buildInfo.SOURCE_DIGEST,
  });
  await assert.rejects(access(new URL('development-build.json.tmp', root)));
});

test('browser build resolves manifest, UI, and module dependencies without TypeScript files', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')) as {
    background: { service_worker: string };
    side_panel: { default_path: string };
    icons: Record<string, string>;
  };
  for (const filename of [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...Object.values(manifest.icons),
  ]) {
    await access(new URL(filename, root));
  }
  assert.equal(manifest.background.service_worker, 'src/background.js');
  assert.equal(manifest.side_panel.default_path, 'ui/sidepanel.html');
  await assert.rejects(access(new URL('packages/', root)));
  for (const directory of ['src/', 'ui/', 'protocol/']) {
    const base = new URL(directory, root);
    for (const filename of await readdir(base)) {
      assert(!filename.endsWith('.ts'), `TypeScript source shipped: ${directory}${filename}`);
      if (filename.endsWith('.js')) {
        const url = new URL(filename, base);
        const ast = parse(await readFile(url, 'utf8'), { sourceType: 'module' });
        for (const statement of ast.program.body) {
          if (
            statement.type !== 'ImportDeclaration' &&
            statement.type !== 'ExportNamedDeclaration' &&
            statement.type !== 'ExportAllDeclaration'
          )
            continue;
          if (!statement.source) continue;
          assert(statement.source.value.startsWith('.'), `Non-browser import in ${filename}`);
          await access(new URL(statement.source.value, url));
        }
      } else if (filename.endsWith('.html')) {
        const url = new URL(filename, base);
        const { document } = parseHTML(await readFile(url, 'utf8'));
        for (const element of document.querySelectorAll('script[src], link[rel="stylesheet"]')) {
          const relative = element.getAttribute('src') ?? element.getAttribute('href');
          assert(relative);
          await access(new URL(relative, url));
        }
      }
    }
  }
});

test('emitted content scripts remain classic scripts for ordered Chrome injection', async () => {
  const files = (await readdir(extensionFile('src/'))).filter(
    (file) => file.startsWith('content-') && file.endsWith('.js')
  );
  assert(files.includes('content-script.js'));
  for (const filename of files) {
    const code = await readFile(extensionFile(`src/${filename}`), 'utf8');
    assert.doesNotThrow(() => parse(code, { sourceType: 'script' }), filename);
  }
});
