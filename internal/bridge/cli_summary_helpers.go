package bridge

import (
	"encoding/json"
	"fmt"
	"strings"
)

func cliCompactInput(r, extra object) object {
	e := object{"elementRef": r["elementRef"]}
	if !cliPresent(e["elementRef"]) {
		e["elementRef"] = cliNull
	}
	for k, v := range extra {
		e[k] = v
	}
	resolution := r.object("resolution")
	strategy := resolution.text("strategy")
	waited, _ := cliNumberValue(resolution["waitedMs"])
	if resolution.boolean("scrolled") || resolution.boolean("recovered") || waited > 0 || cliString(resolution["strategy"]) && (strategy != "elementRef" && strategy != "selector-first" && strategy != "locator-first") {
		notable := cliPick(resolution, "strategy")
		for _, k := range []string{"scrolled", "recovered", "waitedMs", "candidateCount", "oldRef", "newRef"} {
			if v, ok := resolution[k]; ok && string(v) != "false" && (k != "candidateCount" || string(v) != "1") {
				notable[k] = v
			}
		}
		e["resolution"] = value(notable)
	}
	execution := r.object("execution")
	if execution.text("actualMode") == "cdp" || cliTruthy(execution["fallbackReason"]) {
		notable := cliPick(execution, "actualMode")
		if cliTruthy(execution["fallbackReason"]) {
			notable["fallbackReason"] = execution["fallbackReason"]
		}
		e["execution"] = value(notable)
	}
	if r.object("effects") != nil {
		e["effects"] = r["effects"]
	}
	return e
}
func cliCompactHealth(r object) object {
	e := cliClone(r)
	for _, k := range []string{"recovery", "domBaselines", "debugger", "capture"} {
		delete(e, k)
	}
	active := object{}
	for scope, raw := range r.object("recovery") {
		events := cliRecord(raw).object("events")
		for event, raw := range events {
			record := cliRecord(raw)
			if cliTruthy(record["attempts"]) || cliTruthy(record["pending"]) || cliTruthy(record["activeLoop"]) {
				stats := cliPick(record, "attempts", "failures")
				if cliTruthy(record["activeLoop"]) {
					stats["activeLoop"] = value(true)
				}
				active[scope+"."+event] = value(stats)
			}
		}
	}
	if len(active) > 0 {
		e["recovery"] = value(active)
	}
	baselines := r.object("domBaselines")
	if n, ok := cliNumberValue(baselines["baselineCount"]); ok && n > 0 {
		e["domBaselines"] = value(cliPick(baselines, "baselineCount", "bytes"))
	}
	debug := r.object("debugger")
	if cliTruthy(r["debugger"]) && (debug.text("status") != "idle" || cliTruthy(debug["attachedTabCount"])) {
		e["debugger"] = r["debugger"]
	}
	capture := r.object("capture")
	if cliTruthy(r["capture"]) && capture.text("state") != "stopped" {
		e["capture"] = r["capture"]
	}
	return e
}
func cliDescribeEffects(raw json.RawMessage) string {
	effects := cliRecord(raw)
	if !cliPresent(raw) || len(effects) == 0 {
		return ""
	}
	parts := []string{}
	if effects.text("navigation") == "unloading" {
		parts = append(parts, "page is navigating")
	}
	if cliString(effects["url"]) {
		parts = append(parts, "URL → "+cliTruncateURL(effects.text("url")))
	}
	dialogs, _ := cliArray(effects["dialogs"])
	for _, raw := range dialogs {
		r := cliRecord(raw)
		name := ""
		if cliTruthy(r["name"]) {
			name = " \"" + cliJSString(r["name"]) + "\""
		}
		parts = append(parts, cliDefault(r, "role", "dialog")+name+" opened ["+cliJSString(r["ref"])+"]")
	}
	messages, _ := cliArray(effects["messages"])
	for _, raw := range messages {
		r := cliRecord(raw)
		parts = append(parts, cliDefault(r, "role", "status")+": \""+cliJSString(r["text"])+"\"")
	}
	focused := effects.object("focused")
	if cliTruthy(focused["ref"]) {
		name := ""
		if cliTruthy(focused["name"]) {
			name = " \"" + cliJSString(focused["name"]) + "\""
		}
		parts = append(parts, "focus → "+cliDefault(focused, "role", "")+name+" ["+cliJSString(focused["ref"])+"]")
	}
	dom := effects.object("dom")
	_, added := cliNumberValue(dom["added"])
	_, removed := cliNumberValue(dom["removed"])
	if added || removed {
		parts = append(parts, "DOM +"+cliDefault(dom, "added", "0")+"/-"+cliDefault(dom, "removed", "0"))
	}
	if effects.object("target").boolean("removed") {
		parts = append(parts, "target removed")
	}
	if len(parts) == 0 {
		if string(effects["changed"]) == "false" {
			// Target state is a post-action snapshot, not part of changed.
			// A successful value or checked-state edit can still report false.
			if len(effects.object("target")) > 0 {
				return " No additional page effect."
			}
			return " No visible effect."
		}
		return ""
	}
	return " Effects: " + strings.Join(parts, "; ") + "."
}

func cliPatchListSummary(total, shown int) string {
	if shown < total {
		return fmt.Sprintf("%d active patch(es); showing first %d.", total, shown)
	}
	return fmt.Sprintf("%d active patch(es).", total)
}

func cliActionSummary(r object) (string, object, bool) {
	d := func(k, f string) string { return cliDefault(r, k, f) }
	effect := func() string { return cliDescribeEffects(r["effects"]) }
	for _, field := range []string{"performed", "touched", "hovered", "dragged", "closed", "clicked", "focused", "typed", "pressed", "navigated", "scrolled", "resized"} {
		if !cliBoolean(r[field]) {
			continue
		}
		switch field {
		case "performed":
			failures, _ := cliArray(r["failures"])
			suffix := ""
			if len(failures) > 0 {
				suffix = fmt.Sprintf(" with %d failed step(s)", len(failures))
			}
			last := r.object("lastResult")
			evidence := cliDescribeEffects(last.object("result")["effects"])
			if cliTruthy(last["truncated"]) {
				evidence = " Final result omitted: size limit exceeded; inspect with a narrower read, do not replay actions."
			}
			return "Performed " + d("completed", "0") + "/" + d("total", "0") + " step(s) in " + d("elapsedMs", "0") + "ms" + suffix + "." + evidence, r, true
		case "touched":
			mode := ""
			execution := r.object("execution")
			if cliString(execution["actualMode"]) {
				mode = " via " + execution.text("actualMode")
			}
			return "Touched " + d("pointCount", "0") + " point(s)" + mode + ".", r, true
		case "hovered":
			state := "failed"
			if cliTruthy(r["hovered"]) {
				state = "active"
			}
			return "Hover " + state + " on " + cliJSString(r["elementRef"]) + "." + effect(), cliCompactInput(r, nil), true
		case "dragged":
			state := "failed"
			if cliTruthy(r["dragged"]) {
				state = "completed"
			}
			return "Drag " + state + ": " + cliJSString(r["sourceRef"]) + " → " + cliJSString(r["destinationRef"]) + ".", r, true
		case "closed":
			return "Tab " + cliJSString(r["tabId"]) + " closed.", r, true
		case "clicked":
			mode := ""
			execution := r.object("execution")
			if cliString(execution["actualMode"]) {
				mode = " via " + execution.text("actualMode")
			}
			return "Clicked " + d("elementRef", "element") + mode + "." + effect(), cliCompactInput(r, nil), true
		case "focused":
			return "Focused " + d("elementRef", "element") + "." + effect(), cliCompactInput(r, nil), true
		case "typed":
			return "Typed into " + d("elementRef", "element") + "." + effect(), cliCompactInput(r, cliPick(r, "value")), true
		case "pressed":
			key := ""
			if cliTruthy(r["key"]) {
				key = " (" + cliJSString(r["key"]) + ")"
			}
			e := cliClone(r)
			for _, k := range []string{"resolution", "execution", "effects"} {
				delete(e, k)
			}
			compact := cliCompactInput(r, nil)
			delete(compact, "elementRef")
			for k, v := range compact {
				e[k] = v
			}
			return "Key pressed" + key + "." + effect(), e, true
		case "navigated":
			return "Navigated to " + d("url", "page") + ".", cliPick(r, "url"), true
		case "scrolled":
			return "Scrolled to (" + d("x", "0") + ", " + d("y", "0") + ").", r, true
		case "resized":
			return "Viewport resized to " + d("width", "?") + "×" + d("height", "?") + ".", r, true
		}
	}
	return "", nil, false
}

// Entries already implemented by the daemon are shared. The remaining entries
// are presentation-only recovery guidance, checked against the Node registry.
func cliErrorRecovery(code string) object {
	if recovery := daemonErrorRecovery(code); recovery != nil {
		return recovery
	}
	type guidance struct{ alternative, hint string }
	entries := map[string]guidance{
		"WEBMCP_UNAVAILABLE":         {"", "This document does not expose the current WebMCP consumer API. Use structured DOM/input methods; do not enable flags or inject a polyfill without user permission."},
		"WEBMCP_TOOL_STALE":          {"webmcp.list_tools", "The tool reference expired or its document, catalog, or access session changed. Discover and inspect a fresh tool before a new deliberate action."},
		"WEBMCP_BUSY":                {"", "Another WebMCP execution or approval is pending. Wait and inspect postconditions; a timed-out callback may still be running."},
		"WEBMCP_APPROVAL_DENIED":     {"", "User approval was denied, closed, expired, or revoked. No tool was dispatched. Do not repeat the request unless the user asks."},
		"WEBMCP_EXECUTION_UNCERTAIN": {"", "The tool may have executed. Inspect DOM/page postconditions before another deliberate action. Never automatically retry or repeat the action through DOM input."},
		"RESULT_TRUNCATED":           {"", "Result was truncated to fit the response budget. Narrow the query or raise the relevant budget if more detail is required."},
		"RESULT_TOO_LARGE":           {"", "The result exceeds its atomic delivery limit. For screenshots, use artifact delivery, a smaller region, lower scale, or lossy compression. For sensitive reads, use a narrower exact target; partial values are never returned."},
		"SENSITIVE_TARGET_NOT_FOUND": {"page.get_storage", "The exact storage key does not exist. Use page.get_storage to inspect metadata before another deliberate sensitive read."},
		"ELEMENT_STALE":              {"dom.query", "Element was removed from the DOM. Re-query for a fresh elementRef, or retry an input once with recoverStale=true when the same page and a strong unique descriptor still apply."},
		"ELEMENT_AMBIGUOUS":          {"dom.query", "Multiple candidates matched, candidates tied, or a bounded stale-recovery scan could not prove uniqueness. Re-query and use a more specific selector or fresh elementRef."},
		"ELEMENT_NOT_ACTIONABLE":     {"dom.describe", "The target is hidden, disabled, inert, or has no rendered area. Inspect it and choose an actionable target."},
		"ELEMENT_OBSCURED":           {"layout.hit_test", "Another element blocks the target point. Inspect the blocker or wait for the overlay to close."},
		"ELEMENT_NOT_FOUND":          {"dom.query", "No element matched the target selector. Check or narrow the selector with dom.query."},
		"INPUT_UNSUPPORTED":          {"", "The requested execution mode does not support this input operation. Use executionMode=dom or choose a CDP-supported input method."},
		"INPUT_INVALID_TARGET":       {"dom.describe", "The target is not compatible with this input operation or the requested option does not exist. Inspect the target and choose the appropriate control."},
		"INPUT_FOCUS_CHANGED":        {"dom.describe", "Focus moved away from the resolved editable target before native text dispatch. Inspect focus handlers or target the control that retained focus."},
		"DIALOG_BLOCKED":             {"page.handle_dialog", "A JavaScript dialog blocked the operation. Inspect it with page.handle_dialog, then explicitly accept or dismiss it. The operation may already have taken effect and may finish after the dialog closes. Inspect postconditions; never automatically replay the action or sequence."},
		"DIALOG_NOT_OPEN":            {"page.handle_dialog", "No JavaScript dialog is currently observable. Inspect or trigger the dialog before trying another explicit action."},
		"DIALOG_ACTION_CONFLICT":     {"page.handle_dialog", "The observed dialog changed before or during CDP dispatch. Do not repeat the action automatically; inspect the current dialog state first."},
		"CONTENT_SCRIPT_UNAVAILABLE": {"", "The page cannot host the Browser Bridge content script. Switch to a normal http(s) page in the enabled window."},
		"NATIVE_HOST_UNAVAILABLE":    {"", "Native host not reachable. Run `bbx doctor` to diagnose the installation."},
	}
	g, ok := entries[code]
	if !ok {
		return nil
	}
	result := object{"retry": value(false), "hint": value(g.hint)}
	if g.alternative != "" {
		result["alternativeMethod"] = value(g.alternative)
	}
	return result
}
