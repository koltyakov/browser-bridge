import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

export type PngPixels = { width: number; height: number; rgba: Uint8Array };

/** Independent test-only decoder for the lossless 8-bit RGB/RGBA PNGs emitted by Chrome and Go.
 * It deliberately does not use the production comparison/crop implementation. */
export function decodeTestPng(bytes: Uint8Array): PngPixels {
  const png = Buffer.from(bytes);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts: Buffer[] = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const kind = png.toString('ascii', offset + 4, offset + 8);
    assert(offset + 12 + length <= png.length);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'test decoder requires 8-bit channels');
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      assert(channels > 0, 'test decoder requires RGB or RGBA');
      assert.equal(data[12], 0, 'interlaced PNG is outside test decoder scope');
    }
    if (kind === 'IDAT') parts.push(data);
    offset += 12 + length;
    if (kind === 'IEND') break;
  }
  assert(width > 0 && height > 0 && width * height <= 4_000_000);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: (stride + 1) * height });
  assert.equal(raw.length, (stride + 1) * height);
  const decoded = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? decoded[y * stride + x - channels] : 0;
      const up = y > 0 ? decoded[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? decoded[(y - 1) * stride + x - channels] : 0;
      const estimate = left + up - upperLeft;
      const distances = [
        Math.abs(estimate - left),
        Math.abs(estimate - up),
        Math.abs(estimate - upperLeft),
      ];
      const paeth =
        distances[0] <= distances[1] && distances[0] <= distances[2]
          ? left
          : distances[1] <= distances[2]
            ? up
            : upperLeft;
      const prediction =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth;
      decoded[y * stride + x] = (raw[y * (stride + 1) + x + 1] + prediction) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    rgba[pixel * 4] = decoded[pixel * channels];
    rgba[pixel * 4 + 1] = decoded[pixel * channels + 1];
    rgba[pixel * 4 + 2] = decoded[pixel * channels + 2];
    rgba[pixel * 4 + 3] = channels === 4 ? decoded[pixel * channels + 3] : 255;
  }
  return { width, height, rgba };
}
