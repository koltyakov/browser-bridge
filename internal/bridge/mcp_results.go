package bridge

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/json/jsontext"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

func mcpCost(tokens int) string {
	return cliCostClass(float64(tokens))
}

// Agent-side scripts need the protocol fields, not a human-readable preview.
// Reject an oversized result as a whole rather than silently changing its shape.
func mcpDataResult(response object, method string) object {
	const maxDataBytes = 64 * 1024
	raw := response["result"]
	if len(raw) > maxDataBytes {
		return mcpErrorResult("RESULT_TOO_LARGE", fmt.Sprintf("%s returned %d bytes; data mode accepts up to %d.", method, len(raw), maxDataBytes), "Narrow the read or use the method's pagination.")
	}
	out := object{"ok": value(true), "data": raw}
	meta := response.object("meta")
	if kept := cliNotableMeta(meta, meta.text("tab_routing") != "explicit"); len(kept) > 0 {
		out["meta"] = value(kept)
	}
	return mcpResult("Read "+method+"; see structuredContent.data.", out, false)
}

func mcpResult(summary string, structured object, isError bool, images ...object) object {
	content := []object{{"type": value("text"), "text": value(summary)}}
	content = append(content, images...)
	contentJSON := value(content)
	// Count the two canonical values separately. Serializing and decoding the
	// complete envelope just to count bytes repeats work over large evidence.
	size := len(`{"content":,"structuredContent":}`) + len(cliJSON(contentJSON, false)) + len(cliJSON(value(structured), false))
	result := object{"content": contentJSON}
	if isError {
		result["isError"] = value(true)
		size += len(`,"isError":true`)
	}
	tokens := (size + 3) / 4
	structured = mcpClone(structured)
	// Report delivered size only when it is large enough to plan around.
	if tokens > mcpMetaTokenFloor {
		structured["deliveredTokens"], structured["deliveredCostClass"] = value(tokens), value(mcpCost(tokens))
	}
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

func mcpStringLength(text string) int {
	length := 0
	for _, r := range text {
		length++
		if r > 0xffff {
			length++
		}
	}
	return length
}

// Match JavaScript UTF-16 slicing without allocating a copy of the whole input.
// A split surrogate pair becomes a replacement rune, as in the wire formatter.
func mcpSlice(text string, limit int) string {
	limit = max(0, limit)
	used := 0
	for index, r := range text {
		width := 1
		if r > 0xffff {
			width = 2
		}
		if used+width > limit {
			prefix := text[:index]
			if !utf8.ValidString(prefix) {
				prefix = string([]rune(prefix))
			}
			if used < limit {
				prefix += "�"
			}
			return prefix
		}
		used += width
	}
	return text
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
			length := mcpStringLength(text)
			limit := min(length, maxString, maxCharacters-state.characters)
			state.characters += limit
			if limit < length {
				state.truncated = true
				if capture {
					return value(mcpSlice(text, limit) + "[truncated]")
				}
			}
			return value(mcpSlice(text, limit))
		}
		if array, omitted, ok := mcpArrayPrefix(raw, min(100, maxEntries-state.entries)); ok {
			if omitted {
				state.truncated = true
			}
			out := make([]json.RawMessage, len(array))
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

// Retain only the evidence prefix. Validate the remainder without allocating
// RawMessages for entries that the output budget will discard.
func mcpArrayPrefix(raw json.RawMessage, limit int) ([]json.RawMessage, bool, bool) {
	if len(raw) == 0 || raw[0] != '[' {
		return nil, false, false
	}
	dec := jsontext.NewDecoder(bytes.NewReader(raw), jsontext.AllowDuplicateNames(true), jsontext.AllowInvalidUTF8(true))
	if _, err := dec.ReadToken(); err != nil {
		return nil, false, false
	}
	prefix := make([]json.RawMessage, 0, limit)
	omitted := false
	for dec.PeekKind() != ']' {
		if len(prefix) < limit {
			item, err := dec.ReadValue()
			if err != nil {
				return nil, false, false
			}
			prefix = append(prefix, append(json.RawMessage(nil), item...))
		} else {
			omitted = true
			if err := dec.SkipValue(); err != nil {
				return nil, false, false
			}
		}
	}
	if _, err := dec.ReadToken(); err != nil {
		return nil, false, false
	}
	if _, err := dec.ReadToken(); err != io.EOF {
		return nil, false, false
	}
	return prefix, omitted, true
}

func mcpResponse(response object, method string, params object) object {
	if response.boolean("ok") {
		switch {
		case isVisualBaseline(method):
			return mcpVisualBaseline(response.object("result"), method)
		case strings.HasPrefix(method, "screenshot."):
			return mcpScreenshot(response.object("result"), method)
		case method == "sensitive.read":
			return mcpSensitiveRead(response.object("result"))
		case method == "artifact.read":
			return mcpArtifactRead(response.object("result"))
		case method == "network.export_har":
			return mcpHAR(response)
		case method == "session.journal_read":
			return mcpResult("Read exact journal bytes; page until nextOffset is null.", object{"ok": value(true), "evidence": response["result"]}, false)
		}
	}
	structured := mcpPruneMeta(mcpStructuredResponse(response, method, params))
	summary := structured.text("summary")
	if err := structured.object("error"); err != nil {
		summary += mcpErrorDetailsText(err["details"])
	}
	return mcpResult(summary, structured, !structured.boolean("ok"))
}

// mcpMetaTokenFloor is the result size below which per-call size and timing
// fields are omitted. Every field stays in the conversation for the rest of the
// session, so only results large enough to change the next read's budget say
// what they cost.
const mcpMetaTokenFloor = 1000

// mcpPruneMeta removes transport accounting from ordinary results and keeps
// timing only for slow calls. Live access settings stay: they are policy.
func mcpPruneMeta(structured object) object {
	delete(structured, "transportBytes")
	delete(structured, "transportCostClass")
	if tokens, ok := cliNumberValue(structured["transportTokens"]); !ok || tokens <= mcpMetaTokenFloor {
		delete(structured, "transportTokens")
	}
	if timing := structured.object("timing"); timing != nil {
		if total, ok := cliNumberValue(timing["totalMs"]); !ok || total < 1000 {
			delete(structured, "timing")
		}
	}
	return structured
}

// Clients often render only the text of an error result, so the text names
// the error's details too, bounded like a hint. Structured content already
// carries them under error.details.
func mcpErrorDetailsText(details json.RawMessage) string {
	if policy, err := decodeObject(details); err == nil && policy.text("reason") == "policy_setting_disabled" {
		if snapshot := normalizeAccessSettingsSnapshot(policy); snapshot != nil {
			return fmt.Sprintf(" Policy setting: %s. Settings revision: %s. Wait with access.wait_for_change using this revision and the same extensionId; inspect the relevant setting before a deliberate retry.", policy.text("setting"), snapshot.SettingsRevision)
		}
	}
	details = mcpErrorTextDetails(details)
	switch string(details) {
	case "", "null", "{}", "[]":
		return ""
	}
	text := string(cliJSON(details, true))
	if mcpStringLength(text) > 600 {
		text = mcpSlice(text, 600) + "…"
	}
	return " Details: " + text
}

// mcpErrorNoiseKeys are detail fields the summary already conveys (the
// replay warning, sequence timing) or that only matter to diagnostics.
var mcpErrorNoiseKeys = map[string]bool{"aftermath": true, "startedAtMs": true, "elapsedMs": true, "total": true, "byteLength": true, "execution": true}

// mcpErrorTextDetails drops noise keys at any depth so the bounded text keeps
// the fields that say what to change: the failed step, candidates, options.
func mcpErrorTextDetails(details json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(details)
	if len(trimmed) == 0 {
		return details
	}
	switch trimmed[0] {
	case '{':
		fields, err := decodeObject(trimmed)
		if err != nil {
			return details
		}
		for key, child := range fields {
			if mcpErrorNoiseKeys[key] {
				delete(fields, key)
				continue
			}
			fields[key] = mcpErrorTextDetails(child)
		}
		return value(fields)
	case '[':
		var items []json.RawMessage
		if json.Unmarshal(trimmed, &items) != nil {
			return details
		}
		for index, child := range items {
			items[index] = mcpErrorTextDetails(child)
		}
		return value(items)
	}
	return details
}

// Keep image bytes out of structured text. Each image has an immediately preceding
// phase/coordinate label, so disappearance and before/after order remain explicit.
func mcpVisualBaseline(result object, method string) object {
	out := mcpClone(result)
	out["ok"], out["method"] = value(true), value(method)
	images, _ := cliArray(result["images"])
	metadata := []object{}
	content := []object{}
	for _, raw := range images {
		entry := cliRecord(raw)
		imageResult := mcpScreenshot(object{"image": entry["image"], "complete": value(true), "rect": entry["rect"]}, method)
		if imageResult.boolean("isError") {
			return imageResult
		}
		parts, _ := cliArray(imageResult["content"])
		label := object{"phase": entry["phase"], "rect": entry["rect"]}
		metadata = append(metadata, label)
		content = append(content, object{"type": value("text"), "text": value(string(value(label)))})
		for _, part := range parts {
			item := cliRecord(part)
			if item.text("type") == "image" {
				content = append(content, item)
			}
		}
	}
	if result["images"] != nil {
		out["images"] = value(metadata)
	}
	summary := "Visual baseline metadata. Use only when semantic DOM evidence is insufficient; release retained pixels when done."
	if method == "screenshot.baseline.compare" {
		summary = "Visual comparison: " + result.text("reason") + ". " + result.text("guidance")
	}
	return mcpResult(summary, out, false, content...)
}

// Share bounded evidence and error shaping between standalone and batch calls.
// Exact payload methods are handled by mcpResponse and are not batch-safe.
func mcpStructuredResponse(response object, method string, params object) object {
	response = mcpRoundGeometry(response, method)
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
			structured["evidenceMeta"] = value(mcpPick(response.object("result"), "rootIds count total rawTotal source format scanned compact interactiveOnly truncated truncation continuationHint snapshotId deltaUnavailable"))
		}
		if method == "dom.get_accessibility_tree" {
			// Unscoped trees already carry their metadata, snapshot included.
			result := response.object("result")
			if meta := cliOutlineEvidenceMeta(result, evidence); meta != nil && (result["nodes"] == nil || result["scope"] != nil) {
				structured["evidenceMeta"] = value(meta)
			}
		}
		if truncated {
			structured["outputTruncated"], structured["outputLimit"] = value(true), value(limit)
		}
		r := response.object("result")
		switch method {
		case "patch.list":
			patches, ok := cliArray(response["result"])
			if !ok {
				patches, _ = cliArray(r["patches"])
			}
			delivered, _ := cliArray(evidence)
			summary = cliPatchListSummary(len(patches), len(delivered))
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
			// Pagination is reported once, beside the evidence.
			structured["pagination"] = value(pagination)
			delete(listed, "pagination")
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
	return structured
}

// mcpRoundGeometry rounds element rectangles to 0.1px, as dom.query bboxes
// are, before the summary and evidence both repeat them.
func mcpRoundGeometry(response object, method string) object {
	switch method {
	case "layout.get_box_model", "dom.describe", "layout.hit_test":
	default:
		return response
	}
	result := response.object("result")
	if result == nil {
		return response
	}
	result = mcpRoundRect(result)
	if box := result.object("bbox"); box != nil {
		result["bbox"] = value(mcpRoundRect(box))
	}
	// Absent element fields such as a null role are not evidence.
	mcpOmitEmpty(result, "id", "role", "name")
	out := mcpClone(response)
	out["result"] = value(result)
	return out
}

func mcpRoundRect(rect object) object {
	out := mcpClone(rect)
	for _, key := range []string{"x", "y", "width", "height"} {
		if mcpIsNumber(rect[key]) {
			out[key] = value(math.Round(mcpFloat(rect[key])*10) / 10)
		}
	}
	return out
}

// mcpRequestedAttributes keeps allowlisted attributes that the compact node
// fields (id, role, label, testId, cls) do not already carry.
func mcpRequestedAttributes(attrs object, allowlist []string) object {
	requested := object{}
	for _, name := range allowlist {
		switch name {
		case "id", "role", "aria-label", "data-testid", "class":
			continue
		}
		if mcpIsString(attrs[name]) {
			requested[name] = value(mcpSlice(attrs.text(name), 300))
		}
	}
	return requested
}

// mcpOmitEmpty drops fields whose empty string, empty array, or null value
// carries no evidence.
func mcpOmitEmpty(record object, keys ...string) {
	for _, key := range keys {
		switch string(record[key]) {
		case `""`, "[]", "null":
			delete(record, key)
		}
	}
}

// Find results usually name links and buttons by their own text. Drop the
// repeat after the CLI summary, whose shape is a pinned contract.
func mcpDedupeFindEvidence(raw json.RawMessage) json.RawMessage {
	found, err := decodeObject(raw)
	if err != nil {
		return raw
	}
	var nodes []object
	if json.Unmarshal(found["nodes"], &nodes) != nil {
		return raw
	}
	for _, node := range nodes {
		if cliPresent(node["text"]) && string(node["text"]) == string(node["label"]) {
			delete(node, "text")
		}
	}
	found["nodes"] = value(nodes)
	mcpOmitEmpty(found, "truncationReason")
	return value(found)
}

// mcpPerformEvidence shapes a final read step's result as a standalone call to
// its method would be, so returnLastResult costs no more than the follow-up
// read it replaces. Action and wait results stay whole: their summaries carry
// outcomes, such as found: false, that the step result has no other room for.
func mcpPerformEvidence(r, params object) json.RawMessage {
	out := mcpClone(r)
	mcpOmitEmpty(out, "failures")
	last := r.object("lastResult")
	result := last.object("result")
	switch last.text("method") {
	case "page.get_state", "page.get_text", "dom.query", "dom.get_text":
	default:
		return value(out)
	}
	if result == nil {
		return value(out)
	}
	var steps []object
	_ = json.Unmarshal(params["steps"], &steps)
	stepParams := object{}
	if index := int(last.number("index")); index >= 0 && index < len(steps) && steps[index].object("params") != nil {
		stepParams = steps[index].object("params")
	}
	shaped := mcpStructuredResponse(success("", result), last.text("method"), stepParams)
	last = mcpClone(last)
	last["result"] = shaped["evidence"]
	if shaped.boolean("outputTruncated") {
		last["outputTruncated"] = value(true)
	}
	out["lastResult"] = value(last)
	return value(out)
}

// Decode each node once and project only fields the caller can receive.
func mcpDOMQueryNodes(r, params object) (evidence json.RawMessage, count, limit int, truncated, ok bool) {
	var nodes []object
	if json.Unmarshal(r["nodes"], &nodes) != nil {
		return nil, 0, 0, false, false
	}
	count = len(nodes)
	limit = int(params.number("maxNodes"))
	if limit <= 0 {
		limit = 25
	}
	limit = min(limit, 100)
	var allowlist []string
	if params["attributeAllowlist"] != nil {
		_ = json.Unmarshal(params["attributeAllowlist"], &allowlist)
	}
	returned := min(count, limit)
	out := make([]object, 0, returned)
	for _, node := range nodes[:returned] {
		compact := object{}
		attrs := node.object("attrs")
		for _, pair := range [][2]string{{"elementRef", "ref"}, {"tag", "tag"}, {"id", "id"}, {"role", "role"}, {"name", "label"}} {
			if v := node[pair[0]]; cliPresent(v) {
				compact[pair[1]] = v
			}
		}
		for _, pair := range [][2]string{{"id", "id"}, {"role", "role"}, {"aria-label", "label"}, {"data-testid", "testId"}} {
			if v := attrs[pair[0]]; compact[pair[1]] == nil && cliPresent(v) {
				compact[pair[1]] = v
			}
		}
		if mcpIsString(attrs["class"]) {
			parts := strings.SplitN(attrs.text("class"), " ", 4)
			compact["cls"] = value(strings.Join(parts[:min(len(parts), 3)], " "))
		}
		textKey := "textExcerpt"
		if !mcpIsString(node[textKey]) {
			textKey = "text"
		}
		if text := node.text(textKey); text != "" && compact.text("label") != text {
			compact["text"] = value(mcpSlice(text, 120))
		}
		if children, ok := cliArray(node["children"]); ok && len(children) > 0 {
			compact["childCount"] = value(len(children))
		}
		if checked := string(node["checked"]); checked == "true" || checked == "false" {
			compact["checked"] = node["checked"]
		}
		if requested := mcpRequestedAttributes(attrs, allowlist); len(requested) > 0 {
			compact["attrs"] = value(requested)
		}
		if params.boolean("includeBbox") {
			if box := node.object("bbox"); box != nil {
				rounded := object{}
				for _, key := range []string{"x", "y", "width", "height"} {
					rounded[key] = value(math.Round(mcpFloat(box[key])*10) / 10)
				}
				compact["bbox"] = value(rounded)
			}
		}
		out = append(out, compact)
	}
	return value(out), count, limit, count > limit || r.boolean("truncated"), true
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
			_, profiled := cliArray(r["profiles"])
			for _, tab := range tabs {
				out := mcpPick(tab, "extensionId tabId windowId active browserName profileLabel title origin url")
				// The URL already carries its origin, and multi-profile listings
				// name each extensionId's browser and profile once in profiles.
				if origin := tab.text("origin"); origin != "" && strings.HasPrefix(tab.text("url"), origin) {
					delete(out, "origin")
				}
				if profiled {
					delete(out, "browserName")
					delete(out, "profileLabel")
				}
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
			out["tabs"] = value(listed)
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
		length := mcpStringLength(text)
		out := mcpClone(r)
		if key == "text" {
			out = object{"length": value(length), "truncated": value(r.boolean("truncated"))}
			if mcpIsNumber(r["length"]) {
				out["length"] = r["length"]
			}
			// A truncated read names where to continue; pass it as offset.
			for _, field := range []string{"offset", "nextOffset"} {
				if mcpIsNumber(r[field]) {
					out[field] = r[field]
				}
			}
		}
		if key == "html" {
			out = object{"truncated": value(r.boolean("truncated"))}
		}
		out[key] = value(mcpSlice(text, limit))
		out["returnedChars"] = value(min(length, limit))
		return value(out), length > limit, object{"maxCharacters": value(limit)}
	}
	if method == "dom.get_accessibility_tree" && r.text("source") == "dom" && r["scope"] != nil && r["outline"] != nil {
		text := r.text("outline")
		limited := mcpStringLength(text) > 4000
		if limited {
			text = mcpSlice(text, 4000)
			if end := strings.LastIndexByte(text, '\n'); end >= 0 {
				text = text[:end]
			} else {
				text = ""
			}
		}
		return value(text), limited, object{"maxCharacters": value(4000)}
	}
	if method == "dom.query" {
		if evidence, _, limit, truncated, ok := mcpDOMQueryNodes(r, params); ok {
			return evidence, truncated, object{"maxEntries": value(limit)}
		}
	}
	if method == "dom.get_accessibility_tree" {
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
				if r.text("source") == "dom" {
					// DOM trees carry actionable refs and states, not CDP node IDs.
					compact := mcpPick(node, "ref role name depth states matched")
					mcpOmitEmpty(compact, "name", "states")
					out = append(out, compact)
				} else {
					compact := mcpPick(node, "nodeId role name value childIds")
					mcpOmitEmpty(compact, "name", "value")
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
			// Console stacks add about a dozen JSON nodes per frame, so let the
			// character budget, not the node count, bound console entries.
			nodeBudget := 500
			if method == "page.get_console" {
				nodeBudget = 2000
			}
			bounded, extra := mcpBound(value(entries), nodeBudget, 20000, 4000)
			if method == "page.get_network" {
				out := mcpPick(r, "count total filteredTotal dropped abandoned source capture armed armedDuringCapture captureState startedAt inflight ownershipHeld bodyCapture truncated truncation")
				mcpOmitEmpty(out, "capture", "startedAt")
				if string(r["truncated"]) == "false" {
					delete(out, "truncation")
				}
				// Idle capture counters only matter once nonzero; dropped stays
				// as the explicit no-loss signal.
				for _, key := range []string{"abandoned", "inflight"} {
					if string(out[key]) == "0" {
						delete(out, key)
					}
				}
				if string(out["ownershipHeld"]) == "false" {
					delete(out, "ownershipHeld")
				}
				if out["filteredTotal"] != nil && string(out["filteredTotal"]) == string(out["total"]) {
					delete(out, "filteredTotal")
				}
				out["entries"] = bounded
				bounded = value(out)
			}
			return bounded, truncated || extra, object{"maxEntries": value(limit), "maxCharacters": value(20000)}
		}
	}
	if method == "dom.find_by_text" || method == "dom.find_by_role" {
		fallback = mcpDedupeFindEvidence(fallback)
	}
	if method == "input.perform" && r != nil {
		fallback = mcpPerformEvidence(r, params)
	}
	if method == "patch.list" {
		// CLI shortcuts preview ten patches. MCP has no adjacent raw response,
		// so bound the original list and report any actual output truncation.
		fallback = raw
		if r != nil && r["patches"] != nil {
			fallback = r["patches"]
		}
	}
	if strings.HasPrefix(method, "network.intercept.") {
		bounded, truncated := mcpBound(raw, 100, 10000, 4000)
		return bounded, truncated, object{"maxEntries": value(100), "maxCharacters": value(10000)}
	}
	// The CLI summary lists only the keys of result shapes it does not
	// recognize, such as styles.get_matched_rules. MCP has no raw response
	// beside the evidence, so deliver the bounded values instead.
	if keys := cliKeys(raw); len(keys) > 0 && string(fallback) == string(value(keys[:min(10, len(keys))])) {
		fallback = raw
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

// mcpSensitiveRead returns the exact value only in structuredContent. A result
// that does not match its source's exact shape is rejected whole.
func mcpSensitiveRead(r object) object {
	invalid := mcpErrorResult("INVALID_REQUEST", "sensitive.read returned an invalid exact-value response.")
	var exact string
	if !r.boolean("exact") {
		return invalid
	}
	switch r.text("source") {
	case "local_storage", "session_storage":
		if json.Unmarshal(r["value"], &exact) != nil || string(r["value"]) == "null" {
			return invalid
		}
		return object{"content": value([]object{{"type": value("text"), "text": value("Sensitive storage read succeeded. The exact value is available in structuredContent.value.")}}), "structuredContent": value(mcpPick(r, "source value exact"))}
	case "response_body":
		bytesN, ok := serviceInteger(r, "bytes")
		if json.Unmarshal(r["body"], &exact) != nil || string(r["body"]) == "null" || !cliString(r["requestId"]) || !cliString(r["mimeType"]) ||
			(r.text("encoding") != "text" && r.text("encoding") != "base64") || !ok || bytesN < 0 || bytesN > protocol.MaxSensitiveValueBytes {
			return invalid
		}
		return object{"content": value([]object{{"type": value("text"), "text": value("Sensitive response body read succeeded. The exact body is available in structuredContent.body.")}}), "structuredContent": value(mcpPick(r, "source requestId body encoding mimeType bytes exact"))}
	case "indexeddb":
		frameID, frameOK := serviceInteger(r, "frameId")
		described, describedOK := serviceInteger(r, "described")
		// A stored record may itself be JSON null, so only absence is invalid.
		if len(bytes.TrimSpace(r["value"])) == 0 || !cliString(r["database"]) || !cliString(r["store"]) || !frameOK || frameID < 0 || !describedOK || described < 0 || !mcpSensitiveBytes(r) {
			return invalid
		}
		return object{"content": value([]object{{"type": value("text"), "text": value("Sensitive IndexedDB read succeeded. The exact record is available in structuredContent.value.")}}), "structuredContent": value(mcpPick(r, "source frameId database store value described bytes exact"))}
	}
	return invalid
}

// mcpSensitiveBytes accepts a byte count within the atomic sensitive limit.
func mcpSensitiveBytes(r object) bool {
	n, ok := serviceInteger(r, "bytes")
	return ok && n >= 0 && n <= protocol.MaxSensitiveValueBytes
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
