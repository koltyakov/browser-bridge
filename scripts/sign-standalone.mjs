// @ts-check
import fs from 'node:fs/promises';
import { createHash, sign, verify } from 'node:crypto';

const privateKey = process.env.BBX_UPDATE_PRIVATE_KEY;
if (!privateKey)
  throw new Error('BBX_UPDATE_PRIVATE_KEY is required to publish companion updates.');
const publicKey = process.env.BBX_UPDATE_PUBLIC_KEY;
if (
  !publicKey ||
  !verify(
    null,
    Buffer.from('browser-bridge'),
    publicKey,
    sign(null, Buffer.from('browser-bridge'), privateKey)
  )
)
  throw new Error('Update signing keys do not match.');
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
/** @type {Record<string, { name: string, sha256: string, size: number }>} */
const assets = {};
for (const name of await fs.readdir('dist/standalone')) {
  if (!/^bbx-(?:darwin|linux|windows)-[a-z0-9-]+(?:\.exe)?$/.test(name)) continue;
  const bytes = await fs.readFile(`dist/standalone/${name}`);
  assets[`bun-${name.slice(4).replace(/\.exe$/, '')}`] = {
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}
if (Object.keys(assets).length !== 5)
  throw new Error('All five platform executables are required before publishing.');
const manifest = `${JSON.stringify({ version: pkg.version, protocolMajor: Number(pkg.version.split('.')[0]), assets }, null, 2)}\n`;
await fs.writeFile('dist/standalone/companion-update.json', manifest);
await fs.writeFile(
  'dist/standalone/companion-update.sig',
  `${sign(null, Buffer.from(manifest), privateKey).toString('base64')}\n`
);
await fs.writeFile(
  'dist/standalone/SHA256SUMS',
  Object.values(assets)
    .map((asset) => `${asset.sha256}  ${asset.name}\n`)
    .join('')
);
