import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uploadFiles } from '../src/file-transfer.js';
import { createFileStaging } from '../../extension/src/background-files.js';
import { createSuccess } from '../../protocol/src/index.js';
import { FILE_CHUNK_BYTES } from '../../protocol/src/files.js';

test('local uploads stream bounded chunks and release handles after assignment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-upload-'));
  const staging = createFileStaging();
  let chunks = 0;
  let released = 0;
  try {
    const source = Buffer.alloc(FILE_CHUNK_BYTES + 7, 65);
    await fs.writeFile(path.join(dir, 'a.txt'), source);
    const result = await uploadFiles(
      async (method, params) => {
        if (method === 'files.stage') {
          chunks++;
          return createSuccess('id', staging.stage(params, 'owner', 1));
        }
        if (method === 'files.release') {
          released++;
          return createSuccess('id', staging.release(String(params.transferId), 'owner', 1));
        }
        const [file] = staging.resolve(params.files as string[], 'owner', 1);
        assert.deepEqual(Buffer.from(file.bytes), source);
        return createSuccess('id', { assigned: true });
      },
      { selector: '#file' },
      [path.join(dir, 'a.txt')]
    );
    assert.equal(result.ok, true);
    assert.equal(chunks, 2);
    assert.equal(released, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
