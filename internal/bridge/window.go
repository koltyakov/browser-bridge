package bridge

import (
	"encoding/json"
	"math"
	"strings"
	"time"
)

type pendingWindowAction struct {
	source, target *peer
	original       string
	timer          *time.Timer
}

func serviceNumber(o object, key string) (float64, bool) {
	var n float64
	if len(o[key]) == 0 || string(o[key]) == "null" || json.Unmarshal(o[key], &n) != nil {
		return 0, false
	}
	return n, !math.IsNaN(n) && !math.IsInf(n, 0)
}

func normalizeEnabledWindow(w object) object {
	id, idOK := serviceInteger(w, "windowId")
	at, atOK := serviceNumber(w, "enabledAt")
	var title string
	if !idOK || id <= 0 || !atOK || json.Unmarshal(w["title"], &title) != nil || string(w["title"]) == "null" {
		return nil
	}
	result := object{"windowId": value(id), "enabledAt": value(at)}
	title = sanitizeServiceText(title)
	if len(title) > 200 {
		title = title[:200]
	}
	result["title"] = value(title)
	return result
}

func sanitizeServiceText(s string) string {
	return sanitizeIncidentalServiceText(strings.Map(func(r rune) rune {
		if r < 32 && r != '\t' && r != '\n' || r == 127 {
			return -1
		}
		return r
	}, s))
}

func (d *daemon) finishWindowAction(id, message string) {
	pending := d.windowActions[id]
	if pending == nil {
		return
	}
	delete(d.windowActions, id)
	pending.timer.Stop()
	if !d.peers[pending.source] {
		return
	}
	response := object{"type": value("extension.window_action.response"), "requestId": value(pending.original), "ok": value(message == "")}
	if message != "" {
		response["error"] = value(message)
	}
	pending.source.send(response)
}

func (d *daemon) windowAction(p *peer, m object) {
	if m.text("type") == "extension.window_action.result" {
		id := m.text("requestId")
		if pending := d.windowActions[id]; pending != nil && pending.target == p {
			message := ""
			if !m.boolean("ok") {
				message = sanitizeServiceText(m.text("error"))
				if len(message) > 200 {
					message = message[:200]
				}
				if message == "" {
					message = "Window action failed."
				}
			}
			d.finishWindowAction(id, message)
		}
		return
	}
	id, extension, action := m.text("requestId"), m.text("extensionId"), m.text("action")
	window, windowOK := serviceInteger(m, "windowId")
	enabled, enabledOK := serviceNumber(m, "enabledAt")
	var target *peer
	for other := range d.peers {
		if other.role == "extension" && other.id == extension {
			target = other
			break
		}
	}
	message := ""
	count := 0
	for _, item := range d.windowActions {
		if item.source == p {
			count++
		}
	}
	switch {
	case p.role != "extension" || !p.windowControl || !d.peers[p] || id == "" || len(id) > 80 || extension == "" || len(extension) > 80 || (action != "focus" && action != "disable") || !windowOK || window <= 0 || !enabledOK || enabled < 0:
		message = "Invalid window action request."
	case target == nil || target == p:
		message = "The other browser disconnected. Refresh the list and try again."
	case !target.windowControl || target.window == nil:
		message = "Update the other browser's extension and native host to control its window."
	case !target.access || target.window.number("windowId") != window:
		message = "Window access changed. Refresh the list and try again."
	case len(d.windowActions) >= 64 || count >= 16:
		message = "Too many window actions are pending. Try again shortly."
	default:
		targetEnabled, ok := serviceNumber(target.window, "enabledAt")
		if !ok || targetEnabled != enabled {
			message = "Window access changed. Refresh the list and try again."
		}
	}
	if message != "" {
		if len(id) > 80 {
			id = id[:80]
		}
		if id == "" {
			id = "invalid"
		}
		p.send(object{"type": value("extension.window_action.response"), "requestId": value(id), "ok": value(false), "error": value(message)})
		return
	}
	routedID := uniqueID()
	pending := &pendingWindowAction{source: p, target: target, original: id}
	d.windowActions[routedID] = pending
	pending.timer = time.AfterFunc(5*time.Second, func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		d.finishWindowAction(routedID, "The other browser did not respond. Try again.")
	})
	target.send(object{"type": value("extension.window_action.command"), "requestId": value(routedID), "extensionId": value(extension), "action": value(action), "windowId": value(window), "enabledAt": value(enabled)})
}
