import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { generateGzip } from '../../../scripts/generated-gzip.mjs';

test('compressed assets validate content and retain bytes across compression implementations', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-gzip-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'asset.gz');
  const content = Buffer.from('catalog content '.repeat(100));
  await assert.rejects(generateGzip(filename, content, true), /Compressed asset is stale/);
  await generateGzip(filename, content, false);
  const original = await fs.readFile(filename);
  assert.deepEqual(gunzipSync(original), content);
  assert.equal(original[9], 255);
  await generateGzip(filename, content, false);
  assert.deepEqual(await fs.readFile(filename), original);
  const alternate = gzipSync(content, { level: 1 });
  assert.notDeepEqual(alternate, original);
  await fs.writeFile(filename, alternate);
  await generateGzip(filename, content, true);
  await generateGzip(filename, content, false);
  assert.deepEqual(await fs.readFile(filename), alternate);
  await assert.rejects(
    generateGzip(filename, Buffer.from('changed'), true),
    /Compressed asset is stale/
  );
  await fs.writeFile(filename, 'corrupt');
  await assert.rejects(generateGzip(filename, content, true), /Compressed asset is stale/);
  await generateGzip(filename, content, false);
  assert.deepEqual(await fs.readFile(filename), original);
});
