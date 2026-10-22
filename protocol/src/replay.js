// @ts-check

/** @typedef {{ frames: Array<{ at: number, data: string, width?: number, height?: number, tabId?: number }>, events: Array<Record<string, unknown>>, bodies?: Array<Record<string, unknown>>, gaps: number, dropped: number, replayMode?: string, memoryWindow?: boolean }} Replay */

/** Offline renderer playback. Untrusted data is JSON text; only this fixed viewer script executes.
 * @param {Replay} recording @returns {string} */
export function renderReplay(recording) {
  const gaps = Number.isSafeInteger(recording.gaps) ? recording.gaps : 0;
  const dropped = Number.isSafeInteger(recording.dropped) ? recording.dropped : 0;
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const frames = recording.frames
    .filter((frame) => Number.isFinite(frame.at) && /^[A-Za-z0-9+/]+={0,2}$/u.test(frame.data))
    .sort((a, b) => a.at - b.at);
  const data = JSON.stringify({
    frames,
    clicks: recording.events.filter((event) => event.type === 'click'),
  })
    .replaceAll('<', '\\u003c')
    .replaceAll('&', '\\u0026');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>BBX renderer replay</title>
<style>body{font:16px system-ui;background:#17212b;color:#fff;margin:24px}button,input{margin:8px}#stage{position:relative;display:inline-block;max-width:100%}img{max-width:100%;display:block}#click{position:absolute;width:24px;height:24px;border:3px solid #ff574a;border-radius:50%;transform:translate(-50%,-50%);display:none;pointer-events:none}input[type=range]{width:60%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>BBX renderer replay</h1><p>${gaps} capture gaps; ${dropped} dropped events.${recording.memoryWindow ? ' Retained memory window only; use the durable journal for the complete replay.' : ''} Frames represent visible pixels. External assets and page scripts are not loaded.</p>
<div><button id="play">Play</button><select id="speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select><input id="seek" type="range" min="0" max="1" step="1" value="0" aria-label="Replay time"><output id="time"></output></div>
<div id="stage"><img id="frame" alt="Recorded renderer output"><span id="click"></span></div><details><summary>Activity and network events</summary><pre id="events"></pre></details>
<script id="data" type="application/json" nonce="${nonce}">${data}</script><script id="timeline" type="application/json" nonce="${nonce}">${JSON.stringify(recording.events).replaceAll('<', '\\u003c').replaceAll('&', '\\u0026')}</script>
<script nonce="${nonce}">
const {frames,clicks}=JSON.parse(document.getElementById('data').textContent);
const image=document.getElementById('frame'),seek=document.getElementById('seek'),play=document.getElementById('play'),dot=document.getElementById('click');
document.getElementById('events').textContent=JSON.stringify(JSON.parse(document.getElementById('timeline').textContent),null,2);
const start=frames[0]?.at||0,end=Math.max(start,frames.at(-1)?.at||0);seek.max=String(end-start);
let playing=false,position=0,last=0,index=-1,raf=0;
function show(){let low=0,high=frames.length-1,best=-1;while(low<=high){const mid=(low+high)>>1;if(frames[mid].at<=start+position){best=mid;low=mid+1}else high=mid-1}if(best>=0&&best!==index){index=best;image.src='data:image/jpeg;base64,'+frames[index].data}seek.value=String(position);document.getElementById('time').textContent=(position/1000).toFixed(1)+' / '+((end-start)/1000).toFixed(1)+' s';const f=frames[index];const c=clicks.findLast(c=>c.at<=start+position&&start+position-c.at<600&&(!f?.tabId||f.tabId===c.tabId));dot.style.display=c&&f?.width&&f?.height?'block':'none';if(c&&f?.width&&f?.height){dot.style.left=(100*c.x/f.width)+'%';dot.style.top=(100*c.y/f.height)+'%'}}
play.onclick=()=>{cancelAnimationFrame(raf);playing=!playing;if(position>=end-start)position=0;play.textContent=playing?'Pause':'Play';last=performance.now();if(playing)raf=requestAnimationFrame(tick)};seek.oninput=()=>{position=Number(seek.value);show()};
function tick(now){if(playing){position=Math.min(end-start,position+(now-last)*Number(document.getElementById('speed').value));show();if(position>=end-start){playing=false;play.textContent='Play'}}last=now;if(playing)raf=requestAnimationFrame(tick)}show();
</script></html>`;
}

/** Recover complete records; report a partial tail instead of silently claiming a complete recording.
 * @param {string} text @returns {Replay} */
export function parseRecordingJournal(text) {
  /** @type {Replay} */
  const result = {
    frames: [],
    events: [],
    bodies: [],
    gaps: 0,
    dropped: 0,
    replayMode: 'renderer-stream',
  };
  const lines = text.split('\n');
  /** @type {Map<number, number>} */
  const eventIndexes = new Map();
  let ended = false;
  if (lines.pop()) result.gaps++;
  for (const line of lines) {
    if (!line) continue;
    const entry = /** @type {Record<string, unknown>} */ (JSON.parse(line));
    if (!entry || typeof entry !== 'object') throw new Error('Invalid journal record.');
    if (
      entry.kind === 'frame' &&
      entry.frame &&
      typeof entry.frame === 'object' &&
      'data' in entry.frame &&
      typeof entry.frame.data === 'string' &&
      'at' in entry.frame &&
      typeof entry.frame.at === 'number'
    )
      result.frames.push(/** @type {Replay['frames'][number]} */ (entry.frame));
    else if (
      (entry.kind === 'event' || entry.kind === 'event-update') &&
      entry.event &&
      typeof entry.event === 'object'
    ) {
      const event = /** @type {Record<string, unknown>} */ (entry.event);
      const index =
        entry.kind === 'event-update' && typeof event.seq === 'number'
          ? eventIndexes.get(event.seq)
          : undefined;
      if (index !== undefined) result.events[index] = event;
      else {
        if (typeof event.seq === 'number') eventIndexes.set(event.seq, result.events.length);
        result.events.push(event);
      }
    } else if (entry.kind === 'body' && entry.body && typeof entry.body === 'object')
      result.bodies?.push(/** @type {Record<string, unknown>} */ (entry.body));
    else if (entry.kind === 'end') {
      ended = true;
      result.gaps += Number(entry.gaps) || 0;
      result.dropped = Number(entry.dropped) || 0;
    }
  }
  if (!ended) result.gaps++;
  result.events = correlateReplayEvents(result.events);
  return result;
}

/** @template {Record<string, unknown>} T @param {T[]} events @returns {T[]} */
export function correlateReplayEvents(events) {
  /** @type {Map<unknown, T[]>} */
  const tabs = new Map();
  for (const event of events) {
    if (
      event.origin !== 'trusted-event' ||
      !['click', 'input', 'change', 'submit'].includes(String(event.type)) ||
      !Number.isFinite(event.at)
    )
      continue;
    const list = tabs.get(event.tabId) ?? [];
    list.push(event);
    tabs.set(event.tabId, list);
  }
  for (const list of tabs.values()) list.sort((a, b) => Number(a.at) - Number(b.at));
  return events.map((event) => {
    if (
      !['request', 'page-error', 'navigation'].includes(String(event.type)) ||
      !Number.isFinite(event.at)
    )
      return event;
    const actions = tabs.get(event.tabId) ?? [];
    let low = 0,
      high = actions.length - 1,
      best = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (Number(actions[mid].at) <= Number(event.at)) {
        best = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    const action = actions[best];
    const deltaMs = Number(event.at) - Number(action?.at);
    return action && deltaMs <= 2000
      ? {
          ...event,
          correlation: {
            actionSeq: action.seq,
            deltaMs,
            basis: 'same-tab-time-window',
            causality: false,
          },
        }
      : event;
  });
}
