export type Replay = {
  frames: Array<{ at: number; data: string; width?: number; height?: number; tabId?: number }>;
  events: Array<Record<string, unknown>>;
  bodies?: Array<Record<string, unknown>>;
  gaps: number;
  dropped: number;
  replayMode?: string;
  memoryWindow?: boolean;
};

/** Offline renderer playback. Untrusted data is JSON text; only this fixed viewer script executes. */
export function renderReplay(recording: Replay): string {
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

export function correlateReplayEvents<T extends Record<string, unknown>>(events: T[]): T[] {
  const tabs: Map<unknown, T[]> = new Map();
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
