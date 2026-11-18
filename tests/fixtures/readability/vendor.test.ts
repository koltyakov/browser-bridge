import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { documentOnlyParser, vendorReadability } from '../../../scripts/vendor-readability.mjs';

test('audited Readability subset is reproducible and rejects source drift or deletion', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-readability-'));
  try {
    await vendorReadability(false, directory);
    await vendorReadability(true, directory);
    const parser = path.join(directory, 'internal/readability/parser-parse.go');
    const source = await fs.readFile(parser, 'utf8');
    assert.doesNotMatch(source, /func \(ps \*Parser\) Parse\(|dom\.Parse\(|"io"/);
    assert.match(source, /func \(ps \*Parser\) ParseDocument\(/);
    assert.match(source, /func \(ps \*Parser\) ParseAndMutate\(/);
    await fs.writeFile(parser, source + '// unreviewed change\n');
    await assert.rejects(vendorReadability(true, directory), /subset is stale/);
    await fs.rm(parser);
    await assert.rejects(vendorReadability(true, directory), /subset is stale/);
    assert.throws(() => documentOnlyParser('package readability'), /boundaries changed/);
    assert.throws(
      () =>
        documentOnlyParser(
          'package readability\n// Parse parses a reader\n// ParseDocument parses'
        ),
      /assertion|false|truthy/i
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
