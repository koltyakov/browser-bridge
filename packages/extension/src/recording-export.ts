import { renderReplay } from '../../../protocol/src/replay.js';

/** Self-contained sampled-frame viewer. Site strings are escaped text, never active markup. */
export function renderRecording(
  recording: import('../../../protocol/src/replay.js').Replay
): string {
  if (recording.replayMode === 'renderer-stream') return renderReplay(recording);
  const frames = recording.frames.filter((frame) => /^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data));
  const figures = frames
    .map(
      (frame, index) =>
        `<figure id="frame-${index}"><figcaption>${escapeHtml(new Date(frame.at).toISOString())}</figcaption><img alt="Recorded renderer frame ${index + 1}" src="data:image/jpeg;base64,${frame.data}"></figure>`
    )
    .join('\n');
  const events = recording.events
    .map((event) => `<li><code>${escapeHtml(JSON.stringify(event))}</code></li>`)
    .join('\n');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>BBX recording</title><style>body{font:16px system-ui;margin:2rem;max-width:1100px;background:#fff;color:#17212b}img{max-width:100%;height:auto}figure{margin:2rem 0;border-top:1px solid #bbb;padding-top:1rem}code{white-space:pre-wrap;overflow-wrap:anywhere}li{margin:.5rem 0}</style><h1>BBX recording</h1><p>Sampled frames, not video. ${recording.gaps} capture gaps; ${recording.dropped} dropped events. Scroll through frames in capture order. No external assets are loaded.</p>${figures || '<p>No visual frames were captured.</p>'}<details><summary>Activity and network timeline</summary><ol>${events}</ol></details></html>`;
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character
  );
}
