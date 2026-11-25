// Regenerate the checked-in source map fixtures with the repository's esbuild:
//
//   node --import tsx tests/fixtures/source-maps/generate.ts
//
// generated/external.js(.map)  minified alpha bundle with an external map
// generated/inline.js          the same bundle with an inline data: map
// generated/index.js(.map)     alpha and beta concatenated, with an index map
//                              ("sections") assembled from two esbuild maps,
//                              since esbuild does not emit index maps
//
// Every map keeps esbuild's sourcesContent, which holds the CANARY comments,
// so tests can prove that sourcesContent never reaches a result.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'generated');
const SOURCE_MAP_COMMENT = /\n?\/\/# sourceMappingURL=[^\n]*\n?$/u;

async function bundle(
  entry: string,
  outfile: string,
  sourcemap: 'linked' | 'external' | 'inline'
): Promise<{ code: string; map: string | null }> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: path.join(outdir, outfile),
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome114',
    sourcemap,
    write: false,
    logLevel: 'silent',
  });
  let code = '';
  let map: string | null = null;
  for (const file of result.outputFiles) {
    if (file.path.endsWith('.map')) map = file.text;
    else code = file.text;
  }
  return { code, map };
}

function lineCount(text: string): number {
  return text.split('\n').length;
}

await mkdir(outdir, { recursive: true });

const external = await bundle('src/alpha.ts', 'external.js', 'linked');
await writeFile(path.join(outdir, 'external.js'), external.code);
await writeFile(path.join(outdir, 'external.js.map'), `${external.map}\n`);

const inline = await bundle('src/alpha.ts', 'inline.js', 'inline');
await writeFile(path.join(outdir, 'inline.js'), inline.code);

const first = await bundle('src/alpha.ts', 'index.js', 'external');
const second = await bundle('src/beta.ts', 'index.js', 'external');
const firstCode = first.code.replace(SOURCE_MAP_COMMENT, '');
const secondCode = second.code.replace(SOURCE_MAP_COMMENT, '');
const indexCode = `${firstCode}\n${secondCode}\n//# sourceMappingURL=index.js.map\n`;
const indexMap = {
  version: 3,
  file: 'index.js',
  sections: [
    { offset: { line: 0, column: 0 }, map: JSON.parse(first.map ?? '{}') },
    { offset: { line: lineCount(firstCode), column: 0 }, map: JSON.parse(second.map ?? '{}') },
  ],
};
await writeFile(path.join(outdir, 'index.js'), indexCode);
await writeFile(path.join(outdir, 'index.js.map'), `${JSON.stringify(indexMap)}\n`);
