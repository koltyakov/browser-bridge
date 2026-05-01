// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('extension manifest opens the side panel from the toolbar action', async () => {
  const manifestUrl = new URL('../../../manifest.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));

  assert.equal(manifest.action.default_title, 'Browser Bridge');
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, 'packages/extension/ui/sidepanel.html');
});
