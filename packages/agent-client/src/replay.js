// @ts-check
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseRecordingJournal, renderReplay } from '../../protocol/src/replay.js';

/** @param {import('../../protocol/src/replay.js').Replay} recording @param {string} output */
async function writeMp4(recording, output) {
  if (!recording.frames.length) throw new Error('Recording has no frames to encode.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-replay-'));
  try {
    const frames = [...recording.frames].sort((a, b) => a.at - b.at);
    const lines = ['ffconcat version 1.0'];
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      if (!Number.isFinite(frame.at) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(frame.data))
        throw new Error('Invalid recorded frame.');
      const filename = `frame-${index}.jpg`;
      await fs.writeFile(path.join(directory, filename), Buffer.from(frame.data, 'base64'), {
        mode: 0o600,
      });
      lines.push(
        `file '${filename}'`,
        `duration ${Math.max(0.02, Math.min(1800, ((frames[index + 1]?.at ?? frame.at + 100) - frame.at) / 1000))}`
      );
    }
    lines.push(`file 'frame-${frames.length - 1}.jpg'`);
    await fs.writeFile(path.join(directory, 'frames.txt'), lines.join('\n'), { mode: 0o600 });
    await promisify(execFile)(
      'ffmpeg',
      [
        '-nostdin',
        '-n',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        path.join(directory, 'frames.txt'),
        '-vf',
        'scale=1280:900:force_original_aspect_ratio=decrease,pad=1280:900:(ow-iw)/2:(oh-ih)/2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        path.resolve(output),
      ],
      { timeout: 300000, maxBuffer: 1024 * 1024 }
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Download an opaque journal capability or render a local recording without exposing frame bytes to the model.
 * @param {(method: import('../../protocol/src/types.js').BridgeMethod, params: Record<string, unknown>) => Promise<import('../../protocol/src/types.js').BridgeResponse>} call
 * @param {string} source @param {string} output */
export async function exportReplay(call, source, output) {
  let text;
  if (/^journal_[a-f0-9]{64}$/u.test(source)) {
    const chunks = [];
    let offset = 0;
    for (;;) {
      const response = await call('session.journal_read', {
        journalId: source,
        offset,
        maxBytes: 196608,
      });
      if (!response.ok) throw new Error(response.error.message);
      const chunk =
        /** @type {{ offset: number, byteLength: number, totalBytes: number, nextOffset: number | null, data: string }} */ (
          response.result
        );
      const bytes = Buffer.from(chunk.data, 'base64');
      if (
        chunk.offset !== offset ||
        chunk.byteLength !== bytes.length ||
        offset + bytes.length > 128 * 1024 * 1024 ||
        (chunk.nextOffset !== null && chunk.nextOffset !== offset + bytes.length)
      )
        throw new Error('Invalid journal chunk acknowledgement.');
      chunks.push(bytes);
      offset += bytes.length;
      if (chunk.nextOffset === null) break;
      if (!bytes.length) throw new Error('Journal read made no progress.');
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
      throw new Error('Recording must be a file of at most 128 MiB.');
    text = await fs.readFile(source, 'utf8');
  }
  let recording;
  try {
    const parsed = /** @type {import('../../protocol/src/replay.js').Replay} */ (JSON.parse(text));
    if (!Array.isArray(parsed.frames) || !Array.isArray(parsed.events))
      throw new Error('Not a recording');
    recording = parsed;
  } catch {
    recording = parseRecordingJournal(text);
  }
  const extension = path.extname(output).toLowerCase();
  if (extension === '.mp4') await writeMp4(recording, output);
  else if (extension === '.html' || extension === '.json')
    await fs.writeFile(
      output,
      extension === '.html' ? renderReplay(recording) : JSON.stringify(recording),
      { mode: 0o600 }
    );
  else throw new Error('Replay output must be .html, .json, or .mp4. MP4 requires ffmpeg on PATH.');
  return {
    path: path.resolve(output),
    frames: recording.frames.length,
    gaps: recording.gaps,
    dropped: recording.dropped,
  };
}
