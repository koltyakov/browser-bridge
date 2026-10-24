import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { decodeTestPng } from '../_helpers/png.ts';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(kind: string, data: Uint8Array): Buffer {
  const payload = Buffer.concat([Buffer.from(kind), data]);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.length);
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(crc32(payload));
  return Buffer.concat([prefix, payload, suffix]);
}

test('independent PNG test decoder reconstructs Chrome/Go RGB and RGBA row filters', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  for (const channels of [3, 4]) {
    const width = 2;
    const height = 5;
    const stride = width * channels;
    const pixels = Uint8Array.from(
      { length: stride * height },
      (_, index) => (index * 37 + 19) % 256
    );
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = y;
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? pixels[y * stride + x - channels] : 0;
        const up = y ? pixels[(y - 1) * stride + x] : 0;
        const diagonal = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
        let predictor = 0;
        if (y === 1) predictor = left;
        if (y === 2) predictor = up;
        if (y === 3) predictor = Math.floor((left + up) / 2);
        if (y === 4) {
          const prediction = left + up - diagonal;
          predictor = [left, up, diagonal].reduce(
            (best, candidate) =>
              Math.abs(prediction - candidate) < Math.abs(prediction - best) ? candidate : best,
            left
          );
        }
        raw[y * (stride + 1) + x + 1] = (pixels[y * stride + x] - predictor) & 255;
      }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = channels === 3 ? 2 : 6;
    const png = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const decoded = decodeTestPng(png);
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    for (let pixel = 0; pixel < width * height; pixel++) {
      assert.deepEqual(
        [...decoded.rgba.subarray(pixel * 4, pixel * 4 + 4)],
        [
          pixels[pixel * channels],
          pixels[pixel * channels + 1],
          pixels[pixel * channels + 2],
          channels === 3 ? 255 : pixels[pixel * channels + 3],
        ]
      );
    }
  }
  const actualPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgSDnxHwADwAIsn7GFYgAAAABJRU5ErkJggg==',
    'base64'
  );
  assert.deepEqual([...decodeTestPng(actualPng).rgba], [0, 100, 200, 255]);
  assert.throws(() => decodeTestPng(Buffer.from('not PNG')));
});
