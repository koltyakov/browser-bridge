package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type cliReplay struct {
	Frames       []object `json:"frames"`
	Events       []object `json:"events"`
	Bodies       []object `json:"bodies,omitempty"`
	Gaps         int64    `json:"gaps"`
	Dropped      int64    `json:"dropped"`
	ReplayMode   string   `json:"replayMode,omitempty"`
	MemoryWindow bool     `json:"memoryWindow,omitempty"`
}

var journalIDPattern = regexp.MustCompile(`^journal_[a-f0-9]{64}$`)

func replayNumber(o object, key string) float64 {
	var n float64
	_ = json.Unmarshal(o[key], &n)
	return n
}
func parseCLIRecording(data []byte) (cliReplay, error) {
	r := cliReplay{}
	if !utf8.Valid(data) {
		return r, errors.New("recording must be valid UTF-8")
	}
	if json.Unmarshal(data, &r) == nil && r.Frames != nil && r.Events != nil {
		return r, nil
	}
	r = cliReplay{Frames: []object{}, Events: []object{}, Bodies: []object{}, ReplayMode: "renderer-stream"}
	lines := bytes.Split(data, []byte{'\n'})
	if len(lines[len(lines)-1]) > 0 {
		r.Gaps++
	}
	lines = lines[:len(lines)-1]
	ended := false
	indexes := map[int64]int{}
	for _, line := range lines {
		if len(line) == 0 {
			continue
		}
		entry, err := decodeObject(line)
		if err != nil {
			return r, fmt.Errorf("invalid journal record: %w", err)
		}
		switch entry.text("kind") {
		case "frame":
			frame := entry.object("frame")
			var at float64
			if frame.text("data") != "" && json.Unmarshal(frame["at"], &at) == nil {
				r.Frames = append(r.Frames, frame)
			}
		case "event", "event-update":
			event := entry.object("event")
			if event == nil {
				continue
			}
			index, exists := indexes[event.number("seq")]
			if entry.text("kind") == "event-update" && exists {
				r.Events[index] = event
			} else {
				if _, ok := event["seq"]; ok {
					indexes[event.number("seq")] = len(r.Events)
				}
				r.Events = append(r.Events, event)
			}
		case "body":
			if body := entry.object("body"); body != nil {
				r.Bodies = append(r.Bodies, body)
			}
		case "end":
			ended = true
			r.Gaps += entry.number("gaps")
			r.Dropped = entry.number("dropped")
		}
	}
	if !ended {
		r.Gaps++
	}
	correlateCLIEvents(r.Events)
	return r, nil
}
func correlateCLIEvents(events []object) {
	actions := map[int64][]object{}
	for _, e := range events {
		if e.text("origin") != "trusted-event" {
			continue
		}
		switch e.text("type") {
		case "click", "input", "change", "submit":
			actions[e.number("tabId")] = append(actions[e.number("tabId")], e)
		}
	}
	for _, list := range actions {
		sort.SliceStable(list, func(i, j int) bool { return replayNumber(list[i], "at") < replayNumber(list[j], "at") })
	}
	for _, e := range events {
		switch e.text("type") {
		case "request", "page-error", "navigation":
		default:
			continue
		}
		at := replayNumber(e, "at")
		list := actions[e.number("tabId")]
		index := sort.Search(len(list), func(i int) bool { return replayNumber(list[i], "at") > at }) - 1
		if index < 0 {
			continue
		}
		action := list[index]
		delta := at - replayNumber(action, "at")
		if delta <= 2000 {
			e["correlation"] = value(object{"actionSeq": action["seq"], "deltaMs": value(delta), "basis": value("same-tab-time-window"), "causality": value(false)})
		}
	}
}
func exportCLIReplay(ctx context.Context, call cliInvoker, source, output string) (object, error) {
	ext := strings.ToLower(filepath.Ext(output))
	if ext != ".html" && ext != ".json" && ext != ".mp4" {
		return nil, errors.New("replay output must be .html, .json, or .mp4; MP4 requires ffmpeg on PATH")
	}
	var data []byte
	if journalIDPattern.MatchString(source) {
		var out bytes.Buffer
		offset := int64(0)
		for {
			r, err := call(ctx, "session.journal_read", object{"journalId": value(source), "offset": value(offset), "maxBytes": value(196608)})
			if err != nil {
				return nil, err
			}
			chunk, err := decodeCLIBase64(r.text("data"))
			if err != nil {
				return nil, err
			}
			next := offset + int64(len(chunk))
			last := string(r["nextOffset"]) == "null"
			if r.number("offset") != offset || r.number("byteLength") != int64(len(chunk)) || next > 128*1024*1024 || (!last && r.number("nextOffset") != next) {
				return nil, errors.New("invalid journal chunk acknowledgement")
			}
			out.Write(chunk)
			offset = next
			if last {
				break
			}
			if len(chunk) == 0 {
				return nil, errors.New("journal read made no progress")
			}
		}
		data = out.Bytes()
	} else {
		f, err := os.Open(source)
		if err != nil {
			return nil, err
		}
		defer func() { _ = f.Close() }()
		stat, err := f.Stat()
		if err != nil {
			return nil, err
		}
		if !stat.Mode().IsRegular() || stat.Size() > 128*1024*1024 {
			return nil, errors.New("recording must be a file of at most 128 MiB")
		}
		data, err = readReplayFile(f)
		if err != nil {
			return nil, err
		}
	}
	recording, err := parseCLIRecording(data)
	if err != nil {
		return nil, err
	}
	switch ext {
	case ".mp4":
		err = writeCLIReplayMP4(ctx, recording, output)
	case ".html":
		err = writeCLIFile(output, []byte(renderCLIReplay(recording)))
	case ".json":
		var b []byte
		b, err = json.Marshal(recording)
		if err == nil {
			err = writeCLIFile(output, b)
		}
	}
	if err != nil {
		return nil, err
	}
	absolute, err := filepath.Abs(output)
	if err != nil {
		return nil, err
	}
	return object{"path": value(absolute), "frames": value(len(recording.Frames)), "gaps": value(recording.Gaps), "dropped": value(recording.Dropped)}, nil
}
func readReplayFile(f *os.File) ([]byte, error) {
	var out bytes.Buffer
	if _, err := out.ReadFrom(&boundedReplayReader{file: f, remaining: 128*1024*1024 + 1}); err != nil {
		return nil, err
	}
	if out.Len() > 128*1024*1024 {
		return nil, errors.New("recording exceeds 128 MiB")
	}
	return out.Bytes(), nil
}

type boundedReplayReader struct {
	file      *os.File
	remaining int64
}

func (r *boundedReplayReader) Read(p []byte) (int, error) {
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	if len(p) == 0 {
		return 0, errors.New("recording exceeds 128 MiB")
	}
	n, e := r.file.Read(p)
	r.remaining -= int64(n)
	return n, e
}
func recordCLI(ctx context.Context, call cliInvoker, options object, output string) (object, error) {
	ext := strings.ToLower(filepath.Ext(output))
	if ext != ".json" && ext != ".html" && ext != ".mp4" {
		return nil, errors.New("recording output must be .json, .html, or .mp4")
	}
	if ext == ".mp4" {
		options["durable"] = value(true)
		options["replay"] = value(true)
	}
	initial, err := call(ctx, "session.start", options)
	if err != nil {
		return nil, err
	}
	session := initial.text("sessionId")
	if session == "" {
		return nil, errors.New("recording start omitted sessionId")
	}
	defer cleanupCLICall(call, "session.release", object{"sessionId": value(session)})
	if err = printJSON(object{"ok": value(true), "recording": value(initial)}); err != nil {
		return nil, err
	}
	cursor := initial.number("nextCursor")
	for {
		next, err := call(ctx, "session.read", object{"sessionId": value(session), "cursor": value(cursor), "limit": value(100), "waitMs": value(25000)})
		if err != nil {
			return nil, err
		}
		if next.text("journalError") != "" {
			return nil, fmt.Errorf("recording journal failed: %s; recover journal %s", next.text("journalError"), initial.text("journalId"))
		}
		cursor = next.number("nextCursor")
		if !next.boolean("active") {
			break
		}
	}
	result := object{"sessionId": value(session), "path": value(output)}
	if journal := initial.text("journalId"); journal != "" {
		stopped, err := call(ctx, "session.stop", object{"sessionId": value(session)})
		if err != nil {
			return nil, err
		}
		if stopped.text("journalError") != "" {
			return nil, fmt.Errorf("recording journal failed: %s; recover journal %s", stopped.text("journalError"), journal)
		}
		if _, err = exportCLIReplay(ctx, call, journal, output); err != nil {
			return nil, err
		}
		result["journalId"] = value(journal)
		for _, key := range []string{"gaps", "dropped"} {
			if v, ok := stopped[key]; ok {
				result[key] = v
			}
		}
		return result, nil
	}
	format := "json"
	if ext == ".html" {
		format = "html"
	}
	exported, err := call(ctx, "session.export", object{"sessionId": value(session), "format": value(format)})
	if err != nil {
		return nil, err
	}
	data, err := downloadCLIArtifact(ctx, call, exported.object("artifact"), "resource")
	if err != nil {
		return nil, err
	}
	if ext == ".mp4" {
		return nil, errors.New("MP4 recording requires a durable journal")
	}
	if err = writeCLIFile(output, data); err != nil {
		return nil, err
	}
	for _, key := range []string{"gaps", "dropped"} {
		if v, ok := exported[key]; ok {
			result[key] = v
		}
	}
	return result, nil
}
func writeCLIReplayMP4(ctx context.Context, r cliReplay, output string) error {
	if len(r.Frames) == 0 {
		return errors.New("recording has no frames to encode")
	}
	directory, err := os.MkdirTemp("", "bbx-replay-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(directory) }()
	frames := append([]object(nil), r.Frames...)
	sort.SliceStable(frames, func(i, j int) bool { return replayNumber(frames[i], "at") < replayNumber(frames[j], "at") })
	lines := []string{"ffconcat version 1.0"}
	for i, frame := range frames {
		var at float64
		if json.Unmarshal(frame["at"], &at) != nil {
			return errors.New("invalid recorded frame timestamp")
		}
		b, err := decodeCLIBase64(frame.text("data"))
		if err != nil || len(b) == 0 {
			return errors.New("invalid recorded frame")
		}
		filename := fmt.Sprintf("frame-%d.jpg", i)
		if err = os.WriteFile(filepath.Join(directory, filename), b, 0600); err != nil {
			return err
		}
		next := at + 100
		if i+1 < len(frames) {
			next = replayNumber(frames[i+1], "at")
		}
		duration := max(0.02, min(1800.0, (next-at)/1000))
		lines = append(lines, fmt.Sprintf("file '%s'", filename), fmt.Sprintf("duration %g", duration))
	}
	lines = append(lines, fmt.Sprintf("file 'frame-%d.jpg'", len(frames)-1))
	list := filepath.Join(directory, "frames.txt")
	if err = os.WriteFile(list, []byte(strings.Join(lines, "\n")), 0600); err != nil {
		return err
	}
	absolute, err := filepath.Abs(output)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 300*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-n", "-loglevel", "error", "-f", "concat", "-safe", "1", "-i", list, "-vf", "scale=1280:900:force_original_aspect_ratio=decrease,pad=1280:900:(ow-iw)/2:(oh-ih)/2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", absolute)
	cmd.Stderr = os.Stderr
	if err = cmd.Run(); err != nil {
		return fmt.Errorf("encode replay with ffmpeg: %w", err)
	}
	return nil
}
func renderCLIReplay(r cliReplay) string {
	frames := []object{}
	for _, f := range r.Frames {
		var at float64
		if json.Unmarshal(f["at"], &at) != nil {
			continue
		}
		if b, e := decodeCLIBase64(f.text("data")); e == nil && len(b) > 0 {
			frames = append(frames, f)
		}
	}
	sort.SliceStable(frames, func(i, j int) bool { return replayNumber(frames[i], "at") < replayNumber(frames[j], "at") })
	data, _ := json.Marshal(object{"frames": value(frames), "events": value(r.Events)})
	nonce := uniqueID()
	note := ""
	if r.MemoryWindow {
		note = " Retained memory window only; use the durable journal for the complete replay."
	}
	return fmt.Sprintf(`<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'nonce-%s'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>BBX renderer replay</title>
<style>body{font:16px system-ui;background:#17212b;color:white;margin:24px}button,input{margin:8px}#stage{position:relative;display:inline-block;max-width:100%%}img{max-width:100%%;display:block}#click{position:absolute;width:24px;height:24px;border:3px solid #ff574a;border-radius:50%%;transform:translate(-50%%,-50%%);display:none;pointer-events:none}input[type=range]{width:60%%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>BBX renderer replay</h1><p>%d capture gaps; %d dropped events.%s Frames represent visible pixels. External assets and page scripts are not loaded.</p>
<button id="play">Play</button><select id="speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select><input id="seek" type="range" min="0" max="1" step="1" value="0" aria-label="Replay time"><output id="time"></output><div id="stage"><img id="frame" alt="Recorded renderer output"><span id="click"></span></div><details><summary>Activity and network events</summary><pre id="events"></pre></details>
<script id="data" type="application/json" nonce="%s">%s</script><script nonce="%s">
const {frames,events}=JSON.parse(document.getElementById('data').textContent),clicks=events.filter(e=>e.type==='click');document.getElementById('events').textContent=JSON.stringify(events,null,2);
const image=document.getElementById('frame'),seek=document.getElementById('seek'),play=document.getElementById('play'),dot=document.getElementById('click'),start=frames[0]?.at||0,end=Math.max(start,frames.at(-1)?.at||0);seek.max=String(end-start);let playing=false,position=0,last=0,index=-1,raf=0;
function show(){let low=0,high=frames.length-1,best=-1;while(low<=high){const mid=(low+high)>>1;if(frames[mid].at<=start+position){best=mid;low=mid+1}else high=mid-1}if(best>=0&&best!==index){index=best;image.src='data:image/jpeg;base64,'+frames[index].data}seek.value=String(position);document.getElementById('time').textContent=(position/1000).toFixed(1)+' / '+((end-start)/1000).toFixed(1)+' s';const f=frames[index],c=clicks.findLast(c=>c.at<=start+position&&start+position-c.at<600&&(!f?.tabId||f.tabId===c.tabId));dot.style.display=c&&f?.width&&f?.height?'block':'none';if(c&&f?.width&&f?.height){dot.style.left=(100*c.x/f.width)+'%%';dot.style.top=(100*c.y/f.height)+'%%'}}
play.onclick=()=>{cancelAnimationFrame(raf);playing=!playing;if(position>=end-start)position=0;play.textContent=playing?'Pause':'Play';last=performance.now();if(playing)raf=requestAnimationFrame(tick)};seek.oninput=()=>{position=Number(seek.value);show()};function tick(now){if(playing){position=Math.min(end-start,position+(now-last)*Number(document.getElementById('speed').value));show();if(position>=end-start){playing=false;play.textContent='Play'}}last=now;if(playing)raf=requestAnimationFrame(tick)}show();</script></html>`, nonce, r.Gaps, r.Dropped, note, nonce, data, nonce)
}
