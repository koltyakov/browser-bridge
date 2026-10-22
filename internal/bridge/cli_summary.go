package bridge

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
	"time"
)

// cliSummarize mirrors the shared Node formatter. Keep its shape-driven branch
// order: shortcuts deliberately omit method hints for many generic results.
func cliSummarize(response object, method string, now int64) object {
	result := cliSummaryBody(response, method, now)
	meta := response.object("meta")
	if response.boolean("ok") {
		_, tab := cliNumberValue(meta["tab_id"])
		_, active := cliNumberValue(meta["active_tab_id"])
		if tab && active {
			result["summary"] = cliStringValue(cliText(result, "summary") + fmt.Sprintf(" Ran in working tab %s; the user's active tab is %s (pass tabId to switch).", cliJSString(meta["tab_id"]), cliJSString(meta["active_tab_id"])))
		}
	}
	return result
}
func cliSummaryBody(response object, method string, now int64) object {
	warning := response.object("meta").text("protocol_warning")
	if strings.TrimSpace(warning) == "" {
		warning = ""
	}
	done := func(text string, evidence json.RawMessage, withWarning bool) object {
		if withWarning && warning != "" {
			text += " Protocol warning: " + warning
		}
		return object{"ok": value(true), "summary": cliStringValue(text), "evidence": evidence}
	}
	if !response.boolean("ok") {
		e := response.object("error")
		recovery := e["recovery"]
		if !cliPresent(recovery) {
			recovery = value(cliErrorRecovery(e.text("code")))
		}
		hint := cliRecord(recovery).text("hint")
		text := cliJSString(e["code"]) + ": " + cliJSString(e["message"])
		if hint != "" {
			text += " " + hint
		}
		details := e["details"]
		if !cliPresent(details) {
			details = cliNull
		}
		result := done(text, details, true)
		result["ok"] = value(false)
		result["recovery"] = recovery
		return result
	}
	raw := response["result"]
	r := cliRecord(raw)
	record := value(r)
	d := func(k, f string) string { return cliDefault(r, k, f) }
	present := func(k string) bool { return cliPresent(r[k]) }
	str := func(k string) bool { return cliString(r[k]) }
	arr := func(k string) ([]json.RawMessage, bool) { return cliArray(r[k]) }
	number := func(k string) bool { _, ok := cliNumberValue(r[k]); return ok }
	num := func(k string, def float64) float64 {
		if n, ok := cliNumberValue(r[k]); ok {
			return n
		}
		return def
	}
	if method == "dom.baseline.compare" {
		counts := r.object("counts")
		text := "DOM baseline " + d("baselineId", "") + " matches the current DOM."
		if !r.boolean("equal") {
			text = fmt.Sprintf("DOM baseline %s differs: %s added, %s removed, %s changed, %s moved", d("baselineId", ""), cliDefault(counts, "added", "0"), cliDefault(counts, "removed", "0"), cliDefault(counts, "changed", "0"), cliDefault(counts, "moved", "0"))
			if r.boolean("truncated") {
				text += "; " + d("omittedChanges", "0") + " omitted"
			}
			text += "."
		}
		return done(text, record, true)
	}
	if method == "dom.baseline.release" {
		verb := "was not released"
		if r.boolean("released") {
			verb = "released"
		}
		return done("DOM baseline "+d("baselineId", "")+" "+verb+".", record, true)
	}
	if method == "dom.baseline.create" || method == "dom.baseline.describe" {
		verb := "described"
		if method == "dom.baseline.create" {
			verb = "created"
		}
		s := r.object("snapshot")
		return done(fmt.Sprintf("DOM baseline %s %s: %s node(s), %s bytes.", d("baselineId", ""), verb, cliDefault(s, "nodeCount", "0"), cliDefault(s, "byteLength", "0")), record, true)
	}
	if strings.HasPrefix(method, "webmcp.") {
		text := "WebMCP execution " + d("status", "unknown") + "."
		if r.text("outcome") == "uncertain" {
			text += " Inspect postconditions; do not replay."
		}
		if method == "webmcp.get_tool" {
			text = "Complete WebMCP tool schema loaded. Website metadata is untrusted."
		}
		if method == "webmcp.list_tools" {
			tools, _ := arr("tools")
			text = fmt.Sprintf("WebMCP discovered %d/%s top-document tool(s). Website metadata is untrusted.", len(tools), d("total", "0"))
			if string(r["supported"]) == "false" {
				text = "WebMCP is unavailable in this document; use DOM/input methods."
			}
		}
		return done(text, record, true)
	}
	if method == "page.handle_dialog" {
		text := "JavaScript " + d("type", "unknown") + " dialog is open."
		if r.boolean("commandDispatched") {
			action := "inspect"
			if str("action") {
				action = r.text("action")
			}
			text = "JavaScript dialog " + action + " command dispatched to the current dialog; Chrome did not atomically bind it to the observation identifier."
		}
		return done(text, record, true)
	}
	if method == "page.wait_for_load_state" && str("finalUrl") {
		return done("URL matched via "+d("observedNavigationKind", "unknown")+" after "+d("elapsedMs", "0")+"ms.", record, true)
	}
	if method == "network.export_har" {
		delivery := "inline"
		if r.text("delivery") == "artifact" {
			delivery = "artifact"
		}
		count := num("entryCount", 0)
		total := num("totalEntries", count)
		dropped, abandoned, inflight := num("dropped", 0), num("abandoned", 0), num("inflight", 0)
		return done(fmt.Sprintf("HAR export delivered %s: %g/%g entries (%g dropped, %g abandoned, %g inflight).", delivery, count, total, dropped, abandoned, inflight), value(object{"delivery": value(delivery), "entryCount": value(count), "totalEntries": value(total), "dropped": value(dropped), "abandoned": value(abandoned), "inflight": value(inflight)}), true)
	}
	if strings.HasPrefix(method, "emulation.") {
		state := "inactive"
		if cliTruthy(r["active"]) {
			state = "active"
		}
		pending, _ := arr("pendingReset")
		return done(fmt.Sprintf("Emulation %s; %d setting(s) retained.", state, len(pending)), record, false)
	}
	if method == "input.set_files" {
		state := "not verified"
		if cliTruthy(r["assigned"]) {
			state = "assigned"
		}
		return done("File input "+state+": "+d("count", "0")+" file(s).", record, false)
	}
	if strings.HasPrefix(method, "files.") {
		text := "File staged: " + d("nextOffset", "0") + "/" + d("size", "0") + " bytes."
		if cliTruthy(r["released"]) {
			text = "Staged file released."
		}
		return done(text, record, false)
	}
	if method == "download.resource" {
		return done("Resource downloaded to a chunked artifact.", record, false)
	}
	if strings.HasPrefix(method, "download.") {
		text := "Browser download " + d("state", "updated") + ": " + d("bytesReceived", "0") + "/" + d("totalBytes", "-1") + " bytes."
		if cliTruthy(r["released"]) {
			text = "Browser download handle released."
		}
		return done(text, record, false)
	}
	if method == "input.paste_image" {
		return done("Native image paste dispatched. Verify insertion in the editor.", record, false)
	}
	if strings.HasPrefix(method, "session.") {
		state := "stopped"
		if cliTruthy(r["released"]) {
			state = "released"
		} else if r.text("delivery") == "artifact" {
			state = "exported"
		} else if cliTruthy(r["active"]) {
			state = "active"
		}
		return done("Recording "+d("sessionId", "")+": "+state+"; "+d("gaps", "0")+" gap(s).", record, false)
	}
	if str("daemon") {
		access := r.object("access")
		accessText := ""
		if access != nil {
			if cliTruthy(access["enabled"]) {
				if cliTruthy(access["routeReady"]) {
					accessText = " Access: ready on tab " + cliJSString(access["routeTabId"]) + "."
				} else {
					accessText = " Access: enabled"
					if cliString(access["reason"]) {
						accessText += " (" + access.text("reason") + ")"
					} else {
						accessText += "."
					}
				}
				if _, ok := cliNumberValue(access["workingTabId"]); ok && string(access["workingTabId"]) != string(access["routeTabId"]) {
					accessText += " Your working tab is " + cliJSString(access["workingTabId"]) + "."
				}
			} else {
				accessText = " Access: disabled."
			}
		}
		extension := "disconnected"
		if cliTruthy(r["extensionConnected"]) {
			extensions, _ := arr("connectedExtensions")
			labels := []string{}
			for _, raw := range extensions {
				ext := cliRecord(raw)
				label := cliDefault(ext, "browserName", "unknown")
				if cliTruthy(ext["profileLabel"]) {
					label += "/" + cliJSString(ext["profileLabel"])
				}
				if cliTruthy(ext["accessEnabled"]) {
					label += "*"
				}
				labels = append(labels, label)
			}
			extension = fmt.Sprintf("connected (%d: %s)", len(extensions), strings.Join(labels, ", "))
		}
		return done("Daemon: "+r.text("daemon")+". Extension: "+extension+"."+accessText, value(cliCompactHealth(r)), true)
	}
	if mcp, ok := arr("mcpClients"); ok {
		if skills, ok := arr("skillTargets"); ok {
			configured, installed := 0, 0
			for _, raw := range mcp {
				if cliTruthy(cliRecord(raw)["configured"]) {
					configured++
				}
			}
			for _, raw := range skills {
				if cliTruthy(cliRecord(raw)["installed"]) {
					installed++
				}
			}
			return done(fmt.Sprintf("Setup: MCP configured for %d/%d clients; skill installed for %d/%d targets.", configured, len(mcp), installed, len(skills)), record, true)
		}
	}
	if str("content") && str("source") {
		suffix := ""
		if cliTruthy(r["truncated"]) {
			suffix = " (truncated)"
		}
		length := d("length", fmt.Sprint(cliLen(cliText(r, "content"))))
		e := cliPick(r, "format", "source", "length", "truncated", "settlement")
		e["content"] = cliStringValue(cliSlice(cliText(r, "content"), 500))
		return done("Extracted "+r.text("source")+" "+d("format", "text")+": "+length+" chars"+suffix+".", value(e), true)
	}
	if str("url") && str("title") && str("origin") {
		hints := []string{}
		h := cliRecord(r["hints"])
		for _, k := range cliKeys(r["hints"]) {
			if cliTruthy(h[k]) {
				hints = append(hints, k)
			}
		}
		suffix := ""
		if len(hints) > 0 {
			suffix = " [" + strings.Join(hints, ", ") + "]"
		}
		e := cliPick(r, "url", "origin", "title", "hints")
		for _, k := range []string{"scroll", "viewport"} {
			if cliPresent(r[k]) && (r.object(k) != nil || len(r[k]) > 0 && r[k][0] == '[') {
				e[k] = r[k]
			}
		}
		return done("Page: "+cliText(r, "title")+" ("+cliText(r, "origin")+")"+suffix+".", value(e), true)
	}
	if (str("text") || str("value")) && cliBoolean(r["truncated"]) {
		text := cliText(r, "text")
		if !present("text") {
			text = cliText(r, "value")
		}
		length := float64(cliLen(text))
		if number("length") {
			length = num("length", length)
		}
		label := "Page text"
		if method == "dom.get_text" {
			label = "Element text"
		}
		suffix := ""
		if r.boolean("truncated") {
			suffix = " (truncated)"
		}
		return done(fmt.Sprintf("%s: %g chars%s.", label, length, suffix), value(object{"text": cliStringValue(cliSlice(text, 500)), "length": value(length), "truncated": r["truncated"]}), true)
	}
	if tabs, ok := arr("tabs"); ok {
		page := r.object("pagination")
		if page == nil {
			sort.SliceStable(tabs, func(i, j int) bool {
				a, b := cliRecord(tabs[i]), cliRecord(tabs[j])
				return (a.boolean("working") || a.boolean("active")) && !(b.boolean("working") || b.boolean("active"))
			})
			total := len(tabs)
			tabs = tabs[:min(10, total)]
			next := cliNull
			if len(tabs) < total {
				next = value(len(tabs))
			}
			page = object{"totalCount": value(total), "returnedCount": value(len(tabs)), "offset": value(0), "omittedCount": value(total - len(tabs)), "truncated": value(len(tabs) < total), "nextOffset": next}
		}
		text := "Bridge listed " + cliJSString(page["totalCount"]) + " tab(s)."
		if cliTruthy(page["truncated"]) {
			text = fmt.Sprintf("Bridge listed %s tab(s); showing %s at offset %s, %s omitted. Use tabs.list with limit and offset to retrieve another page.", cliJSString(page["totalCount"]), cliJSString(page["returnedCount"]), cliJSString(page["offset"]), cliJSString(page["omittedCount"]))
		}
		e := []object{}
		for _, raw := range tabs {
			e = append(e, cliPick(cliRecord(raw), "tabId", "active", "origin", "title"))
		}
		out := done(text, value(e), true)
		out["pagination"] = value(page)
		return out
	}
	if str("outline") {
		suffix := ""
		if r.boolean("truncated") {
			suffix = ", truncated"
		}
		if r.text("source") == "dom" {
			suffix += "; refs work as input targets"
		}
		return done(fmt.Sprintf("Accessibility outline: %g node(s)%s.", num("count", 0), suffix), r["outline"], true)
	}
	if nodes, ok := arr("nodes"); ok {
		if number("total") && len(nodes) > 0 && cliRecord(nodes[0])["role"] != nil {
			interactive := []json.RawMessage{}
			for _, n := range nodes {
				if cliTruthy(cliRecord(n)["interactive"]) {
					interactive = append(interactive, n)
				}
			}
			shown := interactive
			if len(shown) == 0 {
				for _, n := range nodes {
					role := cliRecord(n)["role"]
					if cliTruthy(role) && cliJSString(role) != "none" && cliJSString(role) != "generic" {
						shown = append(shown, n)
					}
				}
			}
			e := []object{}
			for _, raw := range shown[:min(20, len(shown))] {
				n := cliRecord(raw)
				item := cliPick(n, "role", "name")
				if cliTruthy(n["interactive"]) {
					item["interactive"] = value(true)
				}
				if cliTruthy(n["value"]) {
					item["value"] = n["value"]
				}
				e = append(e, item)
			}
			suffix := ""
			if cliTruthy(r["truncated"]) {
				suffix = ", truncated"
			}
			return done(fmt.Sprintf("Accessibility tree: %s nodes (%d interactive)%s.", d("count", fmt.Sprint(len(nodes))), len(interactive), suffix), value(e), true)
		}
		compact := []object{}
		for _, raw := range nodes[:min(15, len(nodes))] {
			n := cliRecord(raw)
			entry := cliPick(n, "tag")
			if v, ok := n["elementRef"]; ok {
				entry["ref"] = v
			}
			if cliTruthy(n["id"]) {
				entry["id"] = n["id"]
			}
			attrs := n.object("attrs")
			for source, dest := range map[string]string{"id": "id", "role": "role", "aria-label": "label", "data-testid": "testId"} {
				if cliTruthy(attrs[source]) {
					entry[dest] = attrs[source]
				}
			}
			if cliString(attrs["class"]) {
				parts := strings.Split(attrs.text("class"), " ")
				entry["cls"] = value(strings.Join(parts[:min(3, len(parts))], " "))
			}
			if !cliTruthy(entry["role"]) && cliTruthy(n["role"]) {
				entry["role"] = n["role"]
			}
			if !cliTruthy(entry["label"]) && cliTruthy(n["name"]) {
				entry["label"] = n["name"]
			}
			text := ""
			if cliString(n["textExcerpt"]) {
				text = cliText(n, "textExcerpt")
			} else if cliString(n["text"]) {
				text = cliText(n, "text")
			}
			if text != "" {
				if cliLen(text) > 80 {
					text = cliSlice(text, 79) + "…"
				}
				entry["text"] = cliStringValue(text)
			}
			if children, ok := cliArray(n["children"]); ok && len(children) > 0 {
				entry["childCount"] = value(len(children))
			}
			if string(n["visible"]) == "false" {
				entry["visible"] = value(false)
			}
			compact = append(compact, entry)
		}
		if method == "dom.find_by_text" || method == "dom.find_by_role" {
			count := num("count", float64(len(nodes)))
			scanned := cliNull
			if number("scanned") {
				scanned = r["scanned"]
			}
			truncated := r.boolean("truncated")
			after := ""
			if cliPresent(scanned) {
				after = " after scanning " + cliJSString(scanned)
			}
			text := "No matching elements found."
			if count == 0 && truncated {
				text = "No matching elements returned; search stopped" + after + "."
			} else if count > 0 {
				if truncated {
					text = fmt.Sprintf("Found %g matching element(s); additional matches were omitted.", count)
				} else {
					text = fmt.Sprintf("Found %g matching element(s)%s.", count, after)
				}
			}
			if num("hiddenMatches", 0) > 0 {
				text += " " + cliJSString(r["hiddenMatches"]) + " hidden match(es) omitted (includeHidden: true to list)."
			}
			reason := r["truncationReason"]
			if !cliPresent(reason) {
				reason = cliNull
			}
			return done(text, value(object{"found": value(count > 0), "count": value(count), "scanned": scanned, "truncated": value(truncated), "truncationReason": reason, "nodes": value(compact)}), true)
		}
		suffix := ""
		if len(nodes) > 15 {
			suffix = "; showing first 15"
		}
		return done(fmt.Sprintf("DOM query returned %d element(s)%s.", len(nodes), suffix), value(compact), true)
	}
	if cliBoolean(r["rolledBack"]) || cliBoolean(r["rolled_back"]) {
		return done("Patch rolled back.", record, true)
	}
	if str("patchId") {
		return done("Patch "+r.text("patchId")+" applied.", record, true)
	}
	if cliBoolean(r["found"]) {
		text := "Element not found (timed out after " + d("duration", "0") + "ms)."
		if r.boolean("found") {
			text = "Element found after " + d("duration", "0") + "ms."
		}
		e := cliPick(r, "duration")
		e["elementRef"] = r["elementRef"]
		if !cliPresent(e["elementRef"]) {
			e["elementRef"] = cliNull
		}
		out := done(text, value(e), true)
		out["ok"] = r["found"]
		return out
	}
	if r["value"] != nil && str("type") {
		repr := ""
		typeLabel := r.text("type")
		isNull := string(r["value"]) == "null" && typeLabel != "undefined"
		if typeLabel != "undefined" && !isNull {
			if cliString(r["value"]) {
				text := cliText(r, "value")
				repr = text
				if cliLen(text) > 160 {
					repr = fmt.Sprintf("%d chars, starts %s…", cliLen(text), cliJSON(cliStringValue(cliSlice(text, 80)), false))
				}
			} else if (r.object("value") != nil || len(r["value"]) > 0 && r["value"][0] == '[') && len(cliKeys(r["value"])) == 0 {
				repr = "(empty - may be a Promise, Map, or non-serializable value)"
			} else {
				serialized := string(cliJSON(r["value"], false))
				repr = serialized
				if cliLen(serialized) > 160 {
					shape := fmt.Sprintf("%d chars", cliLen(serialized))
					if a, ok := cliArray(r["value"]); ok {
						shape = fmt.Sprintf("%d item(s)", len(a))
					} else if o := r.object("value"); o != nil {
						shape = fmt.Sprintf("%d key(s)", len(o))
					}
					repr = fmt.Sprintf("%s, %d chars as JSON; full value in evidence.value", shape, cliLen(serialized))
				}
			}
		}
		if isNull {
			typeLabel = "null"
		}
		text := "Evaluated to " + typeLabel + "."
		if repr != "" {
			text = "Evaluated to " + typeLabel + ": " + repr
		}
		return done(text, record, true)
	}
	entries, entriesOK := arr("entries")
	first := object{}
	if len(entries) > 0 {
		first = cliRecord(entries[0])
	}
	if entriesOK && len(entries) > 0 && cliString(first["at"]) && cliString(first["method"]) {
		e := []object{}
		for _, raw := range entries[max(0, len(entries)-10):] {
			entry := cliRecord(raw)
			item := cliPick(entry, "at", "method", "ok")
			if cliString(entry["source"]) && entry.text("source") != "" {
				item["source"] = entry["source"]
			}
			e = append(e, item)
		}
		return done(fmt.Sprintf("Log: %d entries.", len(entries)), value(e), true)
	}
	if entriesOK && (len(entries) > 0 && (first.text("type") == "fetch" || first.text("type") == "xhr" || cliString(first["resourceType"])) || len(entries) == 0 && method == "page.get_network") {
		e := []object{}
		for _, raw := range entries[:min(20, len(entries))] {
			entry := cliRecord(raw)
			item := cliPick(entry, "method", "status", "duration")
			item["url"] = cliStringValue(cliTruncateURL(cliText(entry, "url")))
			if cliString(entry["resourceType"]) {
				item["resourceType"] = entry["resourceType"]
			}
			if cliString(entry["failureReason"]) && entry.text("failureReason") != "" {
				item["failureReason"] = entry["failureReason"]
			}
			e = append(e, item)
		}
		return done("Network: "+d("count", fmt.Sprint(len(entries)))+" requests ("+d("total", "?")+" total).", value(e), true)
	}
	if r.boolean("exact") && str("source") && str("value") {
		return done("Sensitive storage value read exactly.", value(object{"source": r["source"], "exact": value(true)}), true)
	}
	if number("count") && str("type") && cliTruthy(r["entries"]) {
		e := []object{}
		for _, raw := range entries {
			entry := cliRecord(raw)
			key := ""
			if cliString(entry["key"]) {
				key = entry.text("key")
			}
			e = append(e, object{"key": value(key), "present": value(entry.boolean("present"))})
		}
		return done("Storage ("+r.text("type")+"): "+cliJSString(r["count"])+" entries.", value(object{"entries": value(e), "total": value(num("total", num("count", 0))), "truncated": value(r.boolean("truncated"))}), true)
	}
	if entriesOK {
		e := []object{}
		for _, raw := range entries[:min(20, len(entries))] {
			entry := cliRecord(raw)
			item := cliPick(entry, "level", "args")
			if ts, ok := cliNumberValue(entry["ts"]); ok {
				item["ago"] = value(cliRelativeTime(float64(now) - ts))
			}
			e = append(e, item)
		}
		return done("Console: "+d("count", fmt.Sprint(len(entries)))+" entries ("+d("total", "?")+" total).", value(e), true)
	}
	if str("html") {
		suffix := ""
		if cliTruthy(r["truncated"]) {
			suffix = " (truncated)"
		}
		e := cliPick(r, "truncated")
		e["html"] = cliStringValue(cliSlice(cliText(r, "html"), 500))
		return done(fmt.Sprintf("HTML fragment: %d chars%s.", cliLen(cliText(r, "html")), suffix), value(e), true)
	}
	if text, evidence, ok := cliActionSummary(r); ok {
		return done(text, value(evidence), true)
	}
	if strings.HasPrefix(method, "input.") && r.object("execution") != nil {
		execution := r.object("execution")
		suffix := ""
		if cliTruthy(r["elementRef"]) {
			suffix = " on " + cliJSString(r["elementRef"])
		}
		extra := cliPick(r, "sourceRef", "destinationRef", "typed", "checked", "selectedValues", "mode", "value")
		for _, k := range []string{"sourceRef", "destinationRef"} {
			if !cliPresent(extra[k]) {
				delete(extra, k)
			}
		}
		return done(method+" completed via "+cliDefault(execution, "actualMode", "dom")+suffix+"."+cliDescribeEffects(r["effects"]), value(cliCompactInput(r, extra)), true)
	}
	if number("tabId") && str("url") {
		action := method
		if str("method") {
			action = r.text("method")
		}
		if action == "navigation.navigate" {
			target := r.text("url")
			if target == "" {
				target = "page"
			}
			return done("Navigated to "+target+".", value(cliPick(r, "url", "title", "status", "tabId")), true)
		}
		suffix := ""
		if r.text("url") != "" {
			suffix = " (" + r.text("url") + ")"
		}
		tab := cliJSString(r["tabId"])
		text := "Tab " + tab + " created" + suffix + "."
		switch action {
		case "navigation.reload":
			text = "Reloaded tab " + tab + suffix + "."
		case "navigation.go_back":
			text = "Navigated back in tab " + tab + suffix + "."
		case "navigation.go_forward":
			text = "Navigated forward in tab " + tab + suffix + "."
		case "tabs.activate":
			text = "Tab " + tab + " activated" + suffix + "."
		case "page.wait_for_load_state":
			status := "ready"
			if str("status") {
				status = r.text("status")
			}
			text = "Tab " + tab + " " + status + suffix + "."
		}
		return done(text, record, true)
	}
	if r.object("metrics") != nil {
		measurement := cliRecord(r["measurement"])
		count := len(cliKeys(r["metrics"]))
		if method == "performance.get_metrics" || measurement.text("kind") == "raw_cdp_counters" {
			return done(fmt.Sprintf("Raw CDP performance counters: %d collected in a browser-maintained point sample; Web Vitals not measured.", count), value(object{"metrics": r["metrics"], "measurement": value(measurement)}), true)
		}
		return done(fmt.Sprintf("Performance: %d metrics collected.", count), r["metrics"], true)
	}
	if str("tag") && str("elementRef") && present("bbox") {
		desc := []string{r.text("tag")}
		if cliTruthy(r["id"]) {
			desc[0] += "#" + cliJSString(r["id"])
		}
		text := cliText(r, "text")
		if t := r.object("text"); t != nil && t["value"] != nil {
			text = cliJSString(t["value"])
		}
		if text != "" {
			desc = append(desc, cliSlice(text, 60))
		}
		box := r.object("bbox")
		if cliTruthy(box["width"]) && cliTruthy(box["height"]) {
			desc = append(desc, cliJSString(box["width"])+"×"+cliJSString(box["height"]))
		}
		e := cliPick(r, "elementRef", "tag", "id", "role", "bbox")
		e["text"] = cliStringValue(text)
		return done("Element "+strings.Join(desc, ", ")+".", value(e), true)
	}
	if r.object("properties") != nil && str("elementRef") {
		return done(fmt.Sprintf("Computed %d style(s) for %s.", len(cliKeys(r["properties"])), r.text("elementRef")), r["properties"], true)
	}
	if method == "styles.get_computed" {
		return done(fmt.Sprintf("Computed %d style(s).", len(r)), record, true)
	}
	if r.object("content") != nil && r.object("border") != nil {
		box := r.object("content")
		return done("Box model: "+cliDefault(box, "width", "?")+"×"+cliDefault(box, "height", "?")+" at ("+cliDefault(box, "x", "0")+", "+cliDefault(box, "y", "0")+").", record, true)
	}
	if number("x") && number("y") && number("width") && number("height") {
		blocked := false
		for _, k := range []string{"clicked", "hovered", "focused", "resized", "tag", "elementRef"} {
			if r[k] != nil {
				blocked = true
			}
		}
		if !blocked {
			return done("Box model: "+cliJSString(r["width"])+"×"+cliJSString(r["height"])+" at ("+cliJSString(r["x"])+", "+cliJSString(r["y"])+").", record, true)
		}
	}
	if patches, ok := cliArray(raw); ok {
		looks := len(patches) == 0 && method == "patch.list"
		if len(patches) > 0 {
			first := cliRecord(patches[0])
			looks = first["patchId"] != nil && first["kind"] != nil
		}
		if looks {
			return done(fmt.Sprintf("%d active patch(es).", len(patches)), value(patches[:min(10, len(patches))]), true)
		}
	}
	if patches, ok := arr("patches"); ok {
		return done(fmt.Sprintf("%d active patch(es).", len(patches)), value(patches[:min(10, len(patches))]), true)
	}
	keys := cliKeys(raw)
	return done(fmt.Sprintf("Bridge method succeeded with %d top-level fields.", len(keys)), value(keys[:min(10, len(keys))]), true)
}

func cliRelativeTime(delta float64) string {
	if delta < 5000 {
		return "just now"
	}
	unit, divisor := "d", float64(86400000)
	if delta < 60000 {
		unit, divisor = "s", 1000
	} else if delta < 3600000 {
		unit, divisor = "m", 60000
	} else if delta < 86400000 {
		unit, divisor = "h", 3600000
	}
	return fmt.Sprintf("%.0f%s ago", math.Floor(delta/divisor+0.5), unit)
}
func cliTruncateURL(raw string) string {
	raw = cliSlice(raw, 4096)
	lower := strings.ToLower(raw)
	sanitized := ""
	if strings.HasPrefix(lower, "data:") {
		mime := strings.FieldsFunc(raw[5:], func(r rune) bool { return r == ';' || r == ',' })
		m := ""
		if len(mime) > 0 {
			for _, r := range mime[0] {
				if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("./+-", r) {
					m += string(r)
				}
			}
		}
		m = cliSlice(m, 100)
		if m != "" {
			return "data:" + m + ";[redacted]"
		}
		return "data:[redacted]"
	}
	if strings.HasPrefix(lower, "blob:") {
		u, e := url.Parse(raw[5:])
		if e != nil || u.Scheme == "" {
			return "blob:[redacted]"
		}
		return "blob:" + u.Scheme + "://" + u.Host + "/[redacted]"
	}
	if strings.HasPrefix(lower, "file:") {
		u, e := url.Parse(raw)
		if e != nil {
			return "file:[redacted-path]"
		}
		parts := strings.FieldsFunc(u.Path, func(r rune) bool { return r == '/' || r == '\\' })
		if len(parts) == 0 {
			return "file:[redacted-path]"
		}
		return "file:[redacted-path]/" + cliSlice(parts[len(parts)-1], 160)
	}
	u, e := url.Parse(raw)
	if e == nil && u.Scheme != "" {
		u.User = nil
		u.Fragment = ""
		if u.Host != "" && u.Path == "" {
			u.Path = "/"
		}
		if u.RawQuery != "" {
			parts := []string{}
			seen := map[string]bool{}
			for _, part := range strings.Split(u.RawQuery, "&") {
				key, _, _ := strings.Cut(part, "=")
				decoded, e := url.QueryUnescape(key)
				if e != nil {
					decoded = key
				}
				if !seen[decoded] {
					seen[decoded] = true
					parts = append(parts, url.QueryEscape(decoded)+"=%5Bredacted%5D")
				}
			}
			u.RawQuery = strings.Join(parts, "&")
		}
		sanitized = cliSlice(u.String(), 4096)
	} else {
		sanitized = strings.SplitN(strings.SplitN(raw, "?", 2)[0], "#", 2)[0]
		if at := strings.Index(sanitized, "@"); at >= 0 {
			if scheme := strings.Index(sanitized, "://"); scheme >= 0 && scheme < at {
				sanitized = sanitized[:scheme+3] + sanitized[at+1:]
			}
		}
		if sanitized == "" && raw != "" {
			sanitized = "[redacted-url]"
		}
	}
	if cliLen(sanitized) <= 120 {
		return sanitized
	}
	u, e = url.Parse(sanitized)
	if e == nil && u.Scheme != "" {
		base := u.Scheme + "://" + u.Host + u.EscapedPath()
		if cliLen(base) > 120 {
			return cliSlice(base, 119) + "…"
		}
		if u.RawQuery != "" {
			return base + "?…"
		}
		return base
	}
	return cliSlice(sanitized, 119) + "…"
}

func cliSummaryNow(response object, method string) object {
	return cliAnnotate(cliSummarize(response, method, time.Now().UnixMilli()), response)
}
