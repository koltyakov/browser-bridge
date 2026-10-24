package bridge

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"
)

func mcpCost(tokens int) string {
	return cliCostClass(float64(tokens))
}

func mcpResult(summary string, structured object, isError bool, images ...object) object {
	content := []object{{"type": value("text"), "text": value(summary)}}
	content = append(content, images...)
	result := object{"content": value(content), "structuredContent": value(structured)}
	if isError {
		result["isError"] = value(true)
	}
	size := len(cliJSON(value(result), false))
	tokens := (size + 3) / 4
	structured = mcpClone(structured)
	structured["deliveredBytes"], structured["deliveredTokens"], structured["deliveredCostClass"] = value(size), value(tokens), value(mcpCost(tokens))
	result["structuredContent"] = value(structured)
	return result
}

// mcpErrorResult reports a typed failure. An optional hint replaces the
// generic recovery hint for the code when the caller knows the precise fix.
func mcpErrorResult(code, message string, hint ...string) object {
	recovery := cliErrorRecovery(code)
	if len(hint) > 0 {
		recovery = mcpClone(recovery)
		recovery["hint"] = value(hint[0])
	}
	summary := code + ": " + message
	if hint := recovery.text("hint"); hint != "" {
		summary += " " + hint
	}
	return mcpResult(summary, object{"ok": value(false), "evidence": value[*string](nil), "error": value(object{"code": value(code), "message": value(message), "details": value[*string](nil)}), "recovery": value(recovery)}, true)
}

func mcpStringLength(text string) int { return len(utf16.Encode([]rune(text))) }
func mcpSlice(text string, limit int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= limit {
		return text
	}
	if limit < 0 {
		limit = 0
	}
	return string(utf16.Decode(units[:limit]))
}

type mcpBoundState struct {
	entries, characters int
	truncated           bool
}

func mcpBound(raw json.RawMessage, maxEntries, maxCharacters, maxString int) (json.RawMessage, bool) {
	return mcpBoundValue(raw, maxEntries, maxCharacters, maxString, false)
}

func mcpBoundValue(raw json.RawMessage, maxEntries, maxCharacters, maxString int, capture bool) (json.RawMessage, bool) {
	state := &mcpBoundState{}
	var visit func(json.RawMessage, int) json.RawMessage
	visit = func(raw json.RawMessage, depth int) json.RawMessage {
		if state.entries >= maxEntries || state.characters >= maxCharacters || depth > 8 {
			state.truncated = true
			return value("[truncated]")
		}
		state.entries++
		var text string
		if len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, &text) == nil {
			limit := min(mcpStringLength(text), maxString, maxCharacters-state.characters)
			state.characters += limit
			if limit < mcpStringLength(text) {
				state.truncated = true
				if capture {
					return value(mcpSlice(text, limit) + "[truncated]")
				}
			}
			return value(mcpSlice(text, limit))
		}
		var array []json.RawMessage
		if len(raw) > 0 && raw[0] == '[' && json.Unmarshal(raw, &array) == nil {
			limit := min(len(array), 100, maxEntries-state.entries)
			if limit < len(array) {
				state.truncated = true
			}
			out := make([]json.RawMessage, limit)
			for i := range out {
				out[i] = visit(array[i], depth+1)
			}
			return value(out)
		}
		if obj, err := decodeObject(raw); err == nil {
			out := object{}
			keys := cliObjectKeys(raw)
			if len(keys) > 100 {
				keys = keys[:100]
				state.truncated = true
			}
			for _, k := range keys {
				if state.entries >= maxEntries || state.characters >= maxCharacters {
					state.truncated = true
					break
				}
				keyLength := mcpStringLength(k)
				if keyLength > maxCharacters-state.characters {
					state.truncated = true
					continue
				}
				state.characters += keyLength
				out[k] = visit(obj[k], depth+1)
			}
			return value(out)
		}
		if raw == nil {
			return value[*string](nil)
		}
		return raw
	}
	result := visit(raw, 0)
	return result, state.truncated
}

func mcpResponse(response object, method string, params object) object {
	if response.boolean("ok") {
		switch {
		case strings.HasPrefix(method, "screenshot."):
			return mcpScreenshot(response.object("result"), method)
		case method == "sensitive.read":
			r := response.object("result")
			var exact string
			if (r.text("source") != "local_storage" && r.text("source") != "session_storage") || !r.boolean("exact") || json.Unmarshal(r["value"], &exact) != nil || string(r["value"]) == "null" {
				return mcpErrorResult("INVALID_REQUEST", "sensitive.read returned an invalid exact-value response.")
			}
			return object{"content": value([]object{{"type": value("text"), "text": value("Sensitive storage read succeeded. The exact value is available in structuredContent.value.")}}), "structuredContent": value(mcpPick(r, "source value exact"))}
		case method == "artifact.read":
			return mcpArtifactRead(response.object("result"))
		case method == "network.export_har":
			return mcpHAR(response)
		case method == "session.journal_read":
			return mcpResult("Read exact journal bytes; page until nextOffset is null.", object{"ok": value(true), "evidence": response["result"]}, false)
		}
	}
	structured := cliSummaryNow(response, method)
	summary := structured.text("summary")
	if !response.boolean("ok") {
		err := mcpClone(response.object("error"))
		// Error evidence is the error's details; report them once, under error.
		var truncated bool
		err["details"], truncated = mcpBound(err["details"], 500, 20000, 4000)
		structured["error"], structured["evidence"] = value(err), cliNull
		if truncated {
			structured["outputTruncated"] = value(true)
		}
	} else {
		evidence, truncated, limit := mcpEvidence(response["result"], method, params, structured["evidence"])
		structured["evidence"] = evidence
		if method == "dom.get_accessibility_tree" && response.object("result")["nodes"] != nil {
			structured["evidenceMeta"] = value(mcpPick(response.object("result"), "rootIds count total rawTotal source format scanned compact interactiveOnly truncated truncation continuationHint"))
		}
		if truncated {
			structured["outputTruncated"], structured["outputLimit"] = value(true), value(limit)
		}
		r := response.object("result")
		switch method {
		case "tabs.list":
			var tabs []object
			_ = json.Unmarshal(r["tabs"], &tabs)
			var delivered []object
			listed, _ := decodeObject(evidence)
			if listed == nil {
				listed = object{}
			}
			_ = json.Unmarshal(listed["tabs"], &delivered)
			total, offset := int64(len(tabs)), int64(0)
			if pagination := r.object("pagination"); pagination != nil {
				total, offset = pagination.number("totalCount"), pagination.number("offset")
			}
			pagination := object{"totalCount": value(total), "returnedCount": value(len(delivered)), "offset": value(offset), "omittedCount": value(max(0, total-int64(len(delivered)))), "truncated": value(int64(len(delivered)) < total), "nextOffset": value[*int](nil)}
			if offset+int64(len(delivered)) < total {
				pagination["nextOffset"] = value(offset + int64(len(delivered)))
			}
			structured["pagination"] = value(pagination)
			listed["pagination"] = value(pagination)
			structured["evidence"] = value(listed)
			summary = fmt.Sprintf("Bridge listed %d tab(s).", total)
			if pagination.boolean("truncated") {
				summary = fmt.Sprintf("Bridge listed %d tab(s); showing %d at offset %d, %d omitted. Use tabs.list with limit and offset to retrieve another page.", total, len(delivered), offset, pagination.number("omittedCount"))
			}
			if r.boolean("partial") {
				summary += " Some browser profiles could not be listed; inspect evidence.profiles."
			}
		}
	}
	structured["summary"] = value(summary)
	return mcpResult(summary, structured, !structured.boolean("ok"))
}

func mcpEvidence(raw json.RawMessage, method string, params object, fallback json.RawMessage) (json.RawMessage, bool, object) {
	r, _ := decodeObject(raw)
	if strings.HasPrefix(method, "webmcp.") {
		return raw, false, object{"maxBytes": value(65536)}
	}
	if method == "tabs.list" {
		var tabs []object
		if json.Unmarshal(r["tabs"], &tabs) == nil {
			if r.object("pagination") == nil {
				page := mcpTabPage(tabs, params)
				_ = json.Unmarshal(page["tabs"], &tabs)
			}
			sort.SliceStable(tabs, func(i, j int) bool {
				return (tabs[i].boolean("working") || tabs[i].boolean("active")) && !tabs[j].boolean("working") && !tabs[j].boolean("active")
			})
			listed := []object{}
			for _, tab := range tabs {
				out := mcpPick(tab, "extensionId tabId windowId active browserName profileLabel title origin url")
				if tab.boolean("working") {
					out["working"] = value(true)
				}
				if tab["title"] != nil {
					out["title"] = value(mcpSlice(tab.text("title"), 200))
				}
				if tab["url"] != nil {
					out["url"] = value(mcpSlice(tab.text("url"), 512))
					if mcpStringLength(tab.text("url")) > 512 {
						out["urlTruncated"] = value(true)
					}
				}
				listed = append(listed, out)
			}
			out := mcpClone(r)
			out["tabCount"], out["tabs"] = value(len(listed)), value(listed)
			bounded, truncated := mcpBound(value(out), 2000, 30000, 1000)
			boundedObject, _ := decodeObject(bounded)
			var boundedTabs []json.RawMessage
			_ = json.Unmarshal(boundedObject["tabs"], &boundedTabs)
			validTabs := []object{}
			for _, item := range boundedTabs {
				tab, err := decodeObject(item)
				if err == nil && mcpIsNumber(tab["tabId"]) {
					validTabs = append(validTabs, tab)
				}
			}
			boundedObject["tabs"] = value(validTabs)
			return value(boundedObject), truncated, object{"maxEntries": value(2000), "maxCharacters": value(30000), "maxStringLength": value(1000)}
		}
	}
	if method == "page.extract_content" || method == "page.get_text" || method == "dom.get_text" || method == "dom.get_html" {
		key, budget, defaultBudget, cap := "text", "textBudget", 8000, 16000
		if method == "page.extract_content" {
			key = "content"
		}
		if method == "dom.get_text" {
			defaultBudget = 600
		}
		if method == "dom.get_html" {
			key, budget, defaultBudget, cap = "html", "maxLength", 2000, 10000
		}
		text := r.text(key)
		if key == "text" && r[key] == nil {
			text = r.text("value")
		}
		limit := int(params.number(budget))
		if limit <= 0 {
			limit = defaultBudget
		}
		limit = min(limit, cap)
		out := mcpClone(r)
		if key == "text" {
			out = object{"length": value(mcpStringLength(text)), "truncated": value(r.boolean("truncated"))}
			if mcpIsNumber(r["length"]) {
				out["length"] = r["length"]
			}
		}
		if key == "html" {
			out = object{"truncated": value(r.boolean("truncated"))}
		}
		out[key] = value(mcpSlice(text, limit))
		out["returnedChars"] = value(min(mcpStringLength(text), limit))
		return value(out), mcpStringLength(text) > limit, object{"maxCharacters": value(limit)}
	}
	if method == "dom.query" || method == "dom.get_accessibility_tree" {
		var nodes []object
		if json.Unmarshal(r["nodes"], &nodes) == nil {
			limit := int(params.number("maxNodes"))
			if limit <= 0 {
				limit = 25
			}
			limit = min(limit, 100)
			truncated := len(nodes) > limit || r.boolean("truncated")
			nodes = nodes[:min(len(nodes), limit)]
			out := []object{}
			for _, node := range nodes {
				if method == "dom.query" {
					attrs := node.object("attrs")
					compact := mcpPick(node, "elementRef:ref tag id role name:label")
					// Null node fields are absent evidence: fall back to attributes, then omit.
					for _, pair := range [][2]string{{"id", "id"}, {"role", "role"}, {"aria-label", "label"}, {"data-testid", "testId"}} {
						if !cliPresent(compact[pair[1]]) && cliPresent(attrs[pair[0]]) {
							compact[pair[1]] = attrs[pair[0]]
						}
					}
					for key, v := range compact {
						if !cliPresent(v) {
							delete(compact, key)
						}
					}
					if classes := attrs.text("class"); mcpIsString(attrs["class"]) {
						parts := strings.Split(classes, " ")
						compact["cls"] = value(strings.Join(parts[:min(len(parts), 3)], " "))
					}
					text := node.text("textExcerpt")
					if !mcpIsString(node["textExcerpt"]) {
						text = node.text("text")
					}
					if text != "" {
						compact["text"] = value(mcpSlice(text, 120))
					}
					if children, ok := cliArray(node["children"]); ok && len(children) > 0 {
						compact["childCount"] = value(len(children))
					}
					out = append(out, compact)
				} else if r.text("source") == "dom" {
					// DOM trees carry actionable refs and states, not CDP node IDs.
					out = append(out, mcpPick(node, "ref role name depth states"))
				} else {
					compact := mcpPick(node, "nodeId role name value childIds")
					for _, key := range []string{"interactive", "semanticInteractive", "focusableAndEnabled"} {
						if node.boolean(key) {
							compact[key] = value(true)
						}
					}
					if _, ok := cliArray(node["childIds"]); !ok {
						compact["childIds"] = value([]string{})
					}
					out = append(out, compact)
				}
			}
			return value(out), truncated, object{"maxEntries": value(limit)}
		}
	}
	if method == "page.get_console" || method == "page.get_network" || method == "log.tail" {
		var entries []json.RawMessage
		if json.Unmarshal(r["entries"], &entries) == nil {
			limit := int(params.number("limit"))
			if limit <= 0 {
				limit = 50
				if method == "log.tail" {
					limit = 20
				}
			}
			limit = min(limit, 100)
			truncated := len(entries) > limit
			if method == "log.tail" && len(entries) > limit {
				entries = entries[len(entries)-limit:]
			} else {
				entries = entries[:min(len(entries), limit)]
			}
			bounded, extra := mcpBound(value(entries), 500, 20000, 4000)
			if method == "page.get_network" {
				out := mcpPick(r, "count total filteredTotal dropped abandoned source capture armed armedDuringCapture captureState startedAt inflight ownershipHeld truncated truncation")
				out["entries"] = bounded
				bounded = value(out)
			}
			return bounded, truncated || extra, object{"maxEntries": value(limit), "maxCharacters": value(20000)}
		}
	}
	if strings.HasPrefix(method, "network.intercept.") {
		bounded, truncated := mcpBound(raw, 100, 10000, 4000)
		return bounded, truncated, object{"maxEntries": value(100), "maxCharacters": value(10000)}
	}
	bounded, truncated := mcpBound(fallback, 500, 20000, 4000)
	return bounded, truncated, object{"maxEntries": value(500), "maxCharacters": value(20000), "maxStringLength": value(4000)}
}

func mcpScreenshot(result object, method string) object {
	if result.text("delivery") == "artifact" {
		artifact := result.object("artifact")
		if artifact.text("artifactId") == "" || !mcpIsNumber(artifact["byteLength"]) {
			return mcpErrorResult("INTERNAL_ERROR", method+" returned invalid artifact metadata.")
		}
		out := mcpPick(result, "delivery artifact mimeType byteLength dimensions context rect complete clipped")
		mcpScreenshotFields(out, result, true)
		out["ok"], out["method"] = value(true), value(method)
		expires := artifact.text("expiresAt")
		if expires == "" {
			expires = "soon"
		}
		return mcpResult(fmt.Sprintf("Captured screenshot artifact (%d bytes, expires %s). Read it in chunks with browser_call method \"artifact.read\", paging offset until nextOffset is null, then delete it with browser_call method \"artifact.delete\" when done.", artifact.number("byteLength"), expires), out, false)
	}
	if !mcpIsString(result["image"]) {
		return mcpErrorResult("INTERNAL_ERROR", method+" returned no image data.")
	}
	image := result.text("image")
	mime := "image/png"
	if strings.HasPrefix(image, "data:") {
		parts := strings.SplitN(image, ",", 2)
		if len(parts) != 2 || !strings.HasSuffix(parts[0], ";base64") {
			return mcpErrorResult("INTERNAL_ERROR", method+" returned invalid base64 image data.")
		}
		mime = strings.TrimSuffix(strings.TrimPrefix(parts[0], "data:"), ";base64")
		image = parts[1]
	}
	image = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, image)
	bytes, err := base64.StdEncoding.Strict().DecodeString(image)
	if err != nil || image == "" || !strings.HasPrefix(mime, "image/") || base64.StdEncoding.EncodeToString(bytes) != image {
		return mcpErrorResult("INTERNAL_ERROR", method+" returned invalid base64 image data.")
	}
	out := mcpPick(result, "rect dimensions context format complete clipped")
	mcpScreenshotFields(out, result, false)
	out["ok"], out["method"], out["mimeType"], out["byteLength"] = value(true), value(method), value(mime), value(len(bytes))
	if out["format"] == nil {
		out["format"] = value(strings.TrimPrefix(mime, "image/"))
	}
	for _, key := range []string{"complete", "clipped"} {
		if out[key] == nil {
			out[key] = value(false)
		}
	}
	return mcpResult(fmt.Sprintf("Captured %s screenshot (%d bytes).", mime, len(bytes)), out, false, object{"type": value("image"), "data": value(image), "mimeType": value(mime)})
}

func mcpScreenshotFields(out, source object, artifact bool) {
	for _, key := range []string{"context", "dimensions"} {
		if artifact && key == "dimensions" {
			continue
		}
		raw := source[key]
		if _, err := decodeObject(raw); err == nil || (len(raw) > 0 && raw[0] == '[') {
			out[key], _ = mcpBoundValue(raw, 500, 50000, 4000, true)
		} else {
			delete(out, key)
		}
	}
	rect := object{}
	for _, key := range []string{"x", "y", "width", "height", "scale"} {
		if raw := source.object("rect")[key]; mcpIsNumber(raw) {
			rect[key] = raw
		}
	}
	delete(out, "rect")
	if len(rect) > 0 {
		out["rect"] = value(rect)
	} else if artifact {
		out["rect"] = value[*int](nil)
	}
	out["complete"], out["clipped"] = value(source.boolean("complete")), value(source.boolean("clipped"))
}

func mcpIsNumber(raw json.RawMessage) bool {
	var n float64
	return len(raw) > 0 && string(raw) != "null" && json.Unmarshal(raw, &n) == nil
}

func mcpFloat(raw json.RawMessage) float64 {
	var number float64
	_ = json.Unmarshal(raw, &number)
	return number
}
func mcpIsString(raw json.RawMessage) bool {
	var s string
	return len(raw) > 0 && string(raw) != "null" && json.Unmarshal(raw, &s) == nil
}

func mcpArtifactRead(r object) object {
	valid := mcpIsString(r["artifactId"]) && mcpIsString(r["data"]) && mcpIsString(r["sha256"])
	for _, key := range []string{"offset", "byteLength", "totalBytes"} {
		valid = valid && mcpIsNumber(r[key])
	}
	valid = valid && (string(r["nextOffset"]) == "null" || mcpIsNumber(r["nextOffset"]))
	if !valid {
		return mcpErrorResult("INVALID_REQUEST", "artifact.read returned invalid chunk metadata.")
	}
	summary := fmt.Sprintf("Read %d bytes from artifact %s at offset %d (%d bytes total). ", r.number("byteLength"), r.text("artifactId"), r.number("offset"), r.number("totalBytes"))
	if string(r["nextOffset"]) == "null" {
		summary += "Artifact fully read; verify the reassembled bytes against sha256."
	} else {
		summary += fmt.Sprintf("Continue reading with offset %d.", r.number("nextOffset"))
	}
	out := mcpPick(r, "artifactId data offset byteLength nextOffset totalBytes sha256 chunkIndex chunkCount expiresAt")
	out["ok"], out["method"] = value(true), value("artifact.read")
	return mcpResult(summary, out, false)
}

var mcpSHA256 = regexp.MustCompile(`^[a-f0-9]{64}$`)

func mcpHAR(response object) object {
	r := response.object("result")
	valid := r.text("format") == "har" && r.text("harVersion") == "1.2" && r.text("mimeType") == "application/json"
	for _, key := range []string{"byteLength", "entryCount", "totalEntries", "dropped", "abandoned", "inflight"} {
		valid = valid && mcpIsNumber(r[key])
	}
	valid = valid && (mcpIsNumber(r["startedAt"]) || string(r["startedAt"]) == "null") && (string(r["truncated"]) == "true" || string(r["truncated"]) == "false") && r.object("truncation") != nil
	switch r.text("captureState") {
	case "armed", "stop_failed", "stopped", "instrumented":
	default:
		valid = false
	}
	if !valid {
		return mcpErrorResult("INVALID_REQUEST", "network.export_har returned invalid HAR metadata.")
	}
	switch r.text("delivery") {
	case "inline":
		log := r.object("har").object("log")
		var entries []json.RawMessage
		if log.text("version") != "1.2" || json.Unmarshal(log["entries"], &entries) != nil || entries == nil {
			return mcpErrorResult("INVALID_REQUEST", "network.export_har returned an invalid inline HAR document.")
		}
	case "artifact":
		artifact := r.object("artifact")
		if artifact.text("kind") != "har" || artifact.text("mimeType") != "application/json" || !mcpIsString(artifact["artifactId"]) || !mcpSHA256.MatchString(artifact.text("sha256")) || !mcpIsNumber(artifact["byteLength"]) || !mcpIsNumber(artifact["chunkSize"]) || !mcpIsNumber(artifact["chunkCount"]) || !mcpIsString(artifact["createdAt"]) || !mcpIsString(artifact["expiresAt"]) {
			return mcpErrorResult("INVALID_REQUEST", "network.export_har returned invalid artifact metadata.")
		}
	default:
		return mcpErrorResult("INVALID_REQUEST", "network.export_har returned an invalid delivery mode.")
	}
	return mcpResult(cliSummaryNow(response, "network.export_har").text("summary"), r, false)
}
