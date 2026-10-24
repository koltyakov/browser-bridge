package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

func cliShortcutPrintMethod(command string) string {
	if definition := cliCommandByName(command); definition != nil && definition.summarize {
		return definition.method
	}
	return ""
}
func cliInvalidBatchItem(method, message string) object {
	return object{"method": value(method), "tabId": cliNull, "ok": value(false), "summary": value("INVALID_REQUEST: " + message), "evidence": cliNull, "durationMs": value(0), "approxTokens": value(0), "error": value(object{"code": value("INVALID_REQUEST"), "message": value(message)})}
}

// cliCompactBatchItem drops item fields that repeat other fields: the raw
// response when evidence already equals it, size and cost triples that
// approxTokens summarizes, unscheduled timing that durationMs covers, null
// errors, and meta that restates cost, routing, or the current protocol. The
// response stays whenever evidence is a bounded view of it.
func cliCompactBatchItem(item object) {
	if !cliPresent(item["error"]) {
		delete(item, "error")
	}
	if !cliPresent(item["response"]) || jsonEqual(item["response"], item["evidence"]) {
		delete(item, "response")
	}
	for _, prefix := range []string{"summary", "transport"} {
		for _, suffix := range []string{"Bytes", "Tokens", "CostClass"} {
			delete(item, prefix+suffix)
		}
	}
	if !item.object("timing").boolean("scheduled") {
		delete(item, "timing")
	}
	meta, kept := item.object("meta"), object{}
	for _, key := range []string{"protocol_warning", "continuation_hint"} {
		if cliPresent(meta[key]) {
			kept[key] = meta[key]
		}
	}
	for _, key := range []string{"budget_truncated", "result_truncated"} {
		if meta.boolean(key) {
			kept[key] = value(true)
		}
	}
	if version := meta.text("protocol_version"); version != "" && version != protocolVersion() {
		kept["protocol_version"] = meta["protocol_version"]
	}
	// Without an explicit tab, the routed tab is the only record of where the
	// call ran.
	if !cliPresent(item["tabId"]) && cliPresent(meta["tab_id"]) {
		kept["tab_id"] = meta["tab_id"]
	}
	if len(kept) == 0 {
		delete(item, "meta")
	} else {
		item["meta"] = value(kept)
	}
}
func prepareCLIBatch(raw json.RawMessage, preset string) ([]object, []object, error) {
	if len(raw) == 0 {
		return nil, nil, errors.New(`Usage: batch '[{"method":"...","params":{...}}, ...]'`)
	}
	if !json.Valid(raw) {
		return nil, nil, errors.New("Invalid JSON syntax. Expected a JSON array of bridge calls.")
	}
	items, ok := cliArray(raw)
	if !ok {
		return nil, nil, errors.New("Batch input must be a JSON array.")
	}
	if len(items) == 0 || len(items) > protocol.MaxBatchCalls {
		return nil, nil, fmt.Errorf("Batch input must contain between 1 and %d calls.", protocol.MaxBatchCalls)
	}
	calls := make([]object, len(items))
	invalid := make([]object, len(items))
	anyInvalid := false
	for i, raw := range items {
		call, e := decodeObject(raw)
		method := call.text("method")
		message := ""
		if e != nil || !cliString(call["method"]) {
			message = "Each batch call needs a method."
		} else if _, ok := catalog.Methods[method]; !ok {
			message = fmt.Sprintf("Unknown bridge method %q.", method)
		}
		if message == "" {
			for _, field := range []string{"extensionId", "targetBrowser", "targetProfile"} {
				if v, ok := call[field]; ok && (!cliString(v) || strings.TrimSpace(call.text(field)) == "") {
					message = field + " must be a non-empty string."
					break
				}
			}
		}
		if message == "" && method == "sensitive.read" {
			message = "sensitive.read is never allowed in batch execution. Call it sequentially."
		}
		params := call.object("params")
		if message == "" {
			if _, exists := call["params"]; exists && params == nil {
				message = "Batch call params must be a JSON object."
			}
		}
		if params == nil {
			params = object{}
		}
		if message == "" {
			if key := misplacedRoutingParam(method, params); key != "" {
				message = key + " inside params is ignored by " + method + ". Set " + key + " on the batch call instead."
			}
		}
		if message == "" {
			for k, v := range catalog.Presets[preset][method] {
				if _, ok := params[k]; !ok {
					params[k] = v
				}
			}
			delete(params, "budgetPreset")
			if !batchSafe(method, params) {
				message = method + " is not safe for batch execution. Call it sequentially."
			}
		}
		if message != "" {
			invalid[i] = cliInvalidBatchItem(method, message)
			anyInvalid = true
			continue
		}
		prepared := cliClone(call)
		prepared["params"] = value(params)
		tab := call.number("tabId")
		if !catalog.Methods[method].boolean("tab") || tab <= 0 {
			prepared["tabId"] = cliNull
		} else {
			prepared["tabId"] = value(tab)
		}
		calls[i] = prepared
	}
	if anyInvalid {
		for i, call := range calls {
			if invalid[i] == nil {
				invalid[i] = cliInvalidBatchItem(call.text("method"), "Batch was not executed because another call failed validation.")
			}
		}
		return nil, invalid, nil
	}
	return calls, nil, nil
}
func cliBatchResult(method string, tab int64, response object, err error, duration, now int64) object {
	if err != nil {
		response = object{"id": value("batch_error"), "ok": value(false), "result": cliNull, "error": value(object{"code": value("INTERNAL_ERROR"), "message": value(err.Error()), "details": cliNull}), "meta": value(object{"protocol_version": value(protocolVersion())})}
	}
	out := cliAnnotate(cliSummarize(response, method, now), response)
	out["method"] = value(method)
	out["tabId"] = cliNull
	if tab > 0 {
		out["tabId"] = value(tab)
	}
	out["durationMs"] = value(duration)
	out["approxTokens"] = out["transportTokens"]
	if err != nil {
		out["approxTokens"] = value(0)
	}
	if meta, ok := response["meta"]; ok {
		out["meta"] = meta
	}
	if response.boolean("ok") {
		out["response"] = response["result"]
	} else {
		out["error"] = response["error"]
	}
	cliCompactBatchItem(out)
	return out
}
