package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

type mcpCatalog struct {
	AllTools           []object `json:"allTools"`
	LegacyTools        []string `json:"legacyTools"`
	LegacyInstructions string   `json:"legacyInstructions"`
}

func mcpCatalogData() mcpCatalog {
	var data mcpCatalog
	_ = json.Unmarshal(catalogBytes, &data)
	if len(data.AllTools) == 0 {
		data.AllTools = catalog.Tools
	}
	if len(data.LegacyTools) == 0 {
		data.LegacyTools = []string{"browser_access", "browser_batch", "browser_call", "browser_health", "browser_status", "browser_toolset"}
	}
	if data.LegacyInstructions == "" {
		data.LegacyInstructions = catalog.Instructions
	}
	return data
}

func (s *mcpSession) tools(era string) []object {
	if era == "modern" {
		return catalog.Tools
	}
	data := mcpCatalogData()
	tools := []object{}
	for _, tool := range data.AllTools {
		name := tool.text("name")
		enabled := s.enabled[name]
		for _, initial := range data.LegacyTools {
			enabled = enabled || name == initial
		}
		if enabled {
			tools = append(tools, tool)
		}
	}
	return tools
}

// Each entry declares the method, whether selector resolution is needed, and
// exactly which arguments the typed handler forwards to the bridge.
var mcpActions = map[string]map[string]string{
	"browser_dom": {
		"query":    "dom.query|selector withinRef maxNodes maxDepth textBudget includeBbox attributeAllowlist",
		"describe": "dom.describe!|", "text": "dom.get_text!|textBudget", "attributes": "dom.get_attributes!|attributes",
		"wait": "dom.wait_for|selector text state timeoutMs", "find_text": "dom.find_by_text|text exact selector maxResults includeHidden",
		"find_role": "dom.find_by_role|role name exact selector maxResults includeHidden", "html": "dom.get_html!|outer maxLength",
		"accessibility_tree": "dom.get_accessibility_tree|selector maxNodes maxDepth compact interactiveOnly source format",
		"baseline_create":    "dom.baseline.create|selector maxNodes maxDepth textBudget attributeAllowlist",
		"baseline_compare":   "dom.baseline.compare|baselineId maxChanges", "baseline_describe": "dom.baseline.describe|baselineId", "baseline_release": "dom.baseline.release|baselineId",
	},
	"browser_styles_layout": {"computed": "styles.get_computed!|properties", "matched_rules": "styles.get_matched_rules!|", "box_model": "layout.get_box_model!|", "hit_test": "layout.hit_test|x y"},
	"browser_page": {
		"state": "page.get_state|", "evaluate": "page.evaluate|expression awaitPromise timeoutMs returnByValue", "console": "page.get_console|level clear limit",
		"handle_dialog": "page.handle_dialog|dialogAction:action promptText expectedDialogId", "wait_for_load": "page.wait_for_load_state|timeoutMs waitForLoad url urlMatch",
		"storage": "page.get_storage|type keys", "text": "page.get_text|textBudget", "extract_content": "page.extract_content|format selector includeMetadata consistency textBudget settleTimeoutMs",
		"network": "page.get_network|clear limit urlPattern source capture", "har": "network.export_har|limit urlPattern delivery", "performance": "performance.get_metrics|",
	},
	"browser_navigation": {"navigate": "navigation.navigate|url waitForLoad timeoutMs", "reload": "navigation.reload|waitForLoad timeoutMs", "go_back": "navigation.go_back|waitForLoad timeoutMs", "go_forward": "navigation.go_forward|waitForLoad timeoutMs", "scroll": "viewport.scroll|top left behavior relative", "resize": "viewport.resize|width height deviceScaleFactor reset"},
	"browser_tabs":       {"list": "tabs.list|limit offset", "create": "tabs.create|url active", "close": "tabs.close|tabId", "activate": "tabs.activate|tabId"},
	"browser_capture":    {"element": "screenshot.capture_element!|format quality delivery scale", "region": "screenshot.capture_region|format quality delivery scale", "full_page": "screenshot.capture_full_page|format quality delivery scale", "cdp_document": "cdp.get_document|", "cdp_dom_snapshot": "cdp.get_dom_snapshot|computedStyles", "cdp_box_model": "cdp.get_box_model|nodeId", "cdp_computed_styles": "cdp.get_computed_styles_for_node|nodeId"},
	"browser_patch":      {"apply_styles": "patch.apply_styles!|declarations important patchId verify", "apply_dom": "patch.apply_dom!|operation value name patchId verify", "list": "patch.list|", "rollback": "patch.rollback|patchId", "commit_baseline": "patch.commit_session_baseline|"},
	"browser_artifact":   {"read": "artifact.read|artifactId offset limit:maxBytes", "delete": "artifact.delete|artifactId"},
	"browser_intercept":  {"add": "network.intercept.add|urlPattern ruleAction:action statusCode body headers", "remove": "network.intercept.remove|ruleId", "list": "network.intercept.list|", "clear": "network.intercept.clear|"},
	"browser_input":      {"click": "input.click|button clickCount modifiers holdMs", "focus": "input.focus|", "type": "input.type|text clear submit modifiers", "fill": "input.fill|value mode", "press_key": "input.press_key|key modifiers holdMs", "cdp_press_key": "cdp.dispatch_key_event|key code modifiers", "set_checked": "input.set_checked|checked", "select_option": "input.select_option|values labels indexes", "hover": "input.hover|duration modifiers", "drag": "input.drag|offsetX offsetY", "scroll_into_view": "input.scroll_into_view|"},
}

func mcpPick(args object, fields string) object {
	result := object{}
	for _, field := range strings.Fields(fields) {
		pair := strings.SplitN(field, ":", 2)
		key := pair[0]
		if len(pair) == 2 {
			key = pair[1]
		}
		if v, exists := args[pair[0]]; exists {
			result[key] = v
		}
	}
	return result
}

func mcpClone(args object) object {
	copy := object{}
	for k, v := range args {
		copy[k] = v
	}
	return copy
}

func inputTarget(args object, ref, selector string, locator bool) object {
	if args.text(ref) != "" {
		return object{"elementRef": args[ref]}
	}
	target := object{}
	if args.text(selector) != "" {
		target["selector"] = args[selector]
	}
	if locator {
		for k, v := range args.object("locator") {
			target[k] = v
		}
	}
	return target
}

func (s *mcpSession) handleTool(ctx context.Context, name string, args object, era string) (object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	args = mcpClone(args)
	if name == "browser_status" {
		return s.status(ctx, args, era)
	}
	if name == "browser_tabs" && args.text("action") == "list" && args.text("destinationId") == "" && !mcpHasTarget(args) {
		return s.destinationTabs(ctx, args, era)
	}
	if name == "browser_batch" {
		return s.batch(ctx, args, era)
	}
	if name == "browser_investigate" {
		return s.investigate(ctx, args, era)
	}
	if name == "browser_setup" {
		scope, err := installCurrentScope()
		if err != nil {
			return nil, err
		}
		scope.global = string(args["global"]) != "false"
		if scope.global {
			scope.project = scope.home
		}
		status := installCollectStatus(scope)
		var clients, skills []object
		_ = json.Unmarshal(status["mcpClients"], &clients)
		_ = json.Unmarshal(status["skillTargets"], &skills)
		configured, installed := 0, 0
		for _, client := range clients {
			if client.boolean("configured") {
				configured++
			}
		}
		for _, skill := range skills {
			if skill.boolean("installed") {
				installed++
			}
		}
		return mcpResult(fmt.Sprintf("Optional agent integration status: %d/%d MCP clients configured, %d/%d skills installed.", configured, len(clients), installed, len(skills)), object{"ok": value(true), "status": value(status)}, false), nil
	}
	if name == "browser_skill" && args.text("destinationId") == "" && !mcpHasTarget(args) {
		return mcpResult("Runtime context retrieved.", object{"ok": value(true), "runtimeContext": value(catalog.Runtime)}, false), nil
	}
	method := args.text("method")
	params := mcpClone(args.object("params"))
	ref := false
	switch name {
	case "browser_call":
	case "browser_health", "browser_status":
		method, params = "health.ping", object{}
	case "browser_skill":
		method, params = "skill.get_runtime_context", object{}
	case "browser_access":
		method, params = "access.request", mcpPick(args, "intent")
	case "browser_setup":
		method, params = "setup.get_status", mcpPick(args, "global")
	case "browser_logs":
		method, params = "log.tail", mcpPick(args, "limit")
	case "browser_sensitive_read":
		method, params = "sensitive.read", mcpPick(args, "source key")
	default:
		spec := mcpActions[name][args.text("action")]
		if spec == "" {
			return mcpErrorResult("INVALID_REQUEST", fmt.Sprintf("Unsupported %s action %q.", name, args.text("action"))), nil
		}
		parts := strings.SplitN(spec, "|", 2)
		ref = strings.HasSuffix(parts[0], "!")
		method = strings.TrimSuffix(parts[0], "!")
		params = mcpPick(args, parts[1])
	}
	if _, ok := catalog.Methods[method]; !ok {
		return mcpErrorResult("INVALID_REQUEST", "Unknown bridge method: "+method), nil
	}
	if method == "protocol.describe" {
		return mcpDescribe(params), nil
	}
	if name == "browser_dom" {
		if method == "dom.query" && params.text("selector") == "" {
			params["selector"] = value("body")
		}
		if method == "dom.get_attributes" && params["attributes"] == nil {
			params["attributes"] = value([]string{})
		}
		if args.text("budgetPreset") == "" && (method == "dom.query" || method == "dom.baseline.create" || method == "dom.get_accessibility_tree") {
			selector := strings.TrimSpace(args.text("selector"))
			if method == "dom.get_accessibility_tree" {
				args["budgetPreset"] = value("normal")
			} else if args.text("elementRef") != "" || (strings.HasPrefix(selector, "#") && !strings.ContainsAny(strings.TrimPrefix(selector, "#"), " .>+~[#:")) {
				args["budgetPreset"] = value("quick")
			} else if selector != "" && selector != "*" && selector != "body" {
				preset := "normal"
				if len(strings.Fields(selector)) >= 4 {
					preset = "deep"
				}
				args["budgetPreset"] = value(preset)
			}
		}
	}
	if name == "browser_capture" && strings.HasPrefix(method, "screenshot.") {
		if params["delivery"] == nil {
			params["delivery"] = value("auto")
		}
		if args.text("action") == "region" {
			for k, v := range args.object("rect") {
				params[k] = v
			}
			if params["x"] == nil || params["y"] == nil || mcpFloat(params["width"]) <= 0 || mcpFloat(params["height"]) <= 0 {
				return mcpErrorResult("INVALID_REQUEST", "rect with finite x, y, width, and height is required for region capture."), nil
			}
		}
	}
	if name == "browser_input" {
		if method != "cdp.dispatch_key_event" && method != "input.scroll_into_view" {
			for k, v := range mcpPick(args, "executionMode recoverStale timeoutMs observe") {
				params[k] = v
			}
		}
		if method == "input.drag" {
			source, destination := inputTarget(args, "sourceElementRef", "sourceSelector", false), inputTarget(args, "destinationElementRef", "destinationSelector", false)
			if len(source) == 0 || len(destination) == 0 {
				return mcpErrorResult("INVALID_REQUEST", "Source and destination targets are required for drag."), nil
			}
			params["source"], params["destination"] = value(source), value(destination)
		} else if method != "cdp.dispatch_key_event" {
			target := inputTarget(args, "elementRef", "selector", true)
			if len(target) == 0 && method != "input.press_key" {
				return mcpErrorResult("INVALID_REQUEST", "Provide elementRef, selector, or locator."), nil
			}
			if len(target) > 0 {
				params["target"] = value(target)
			}
		}
	}
	if validation := mcpValidateAction(name, method, params, args); validation != "" {
		return mcpErrorResult("INVALID_REQUEST", validation), nil
	}
	if ref {
		elementRef := args.text("elementRef")
		if elementRef == "" {
			if args.text("selector") == "" {
				return mcpErrorResult("INVALID_REQUEST", "Provide either elementRef or selector."), nil
			}
			response, err := s.bridge(ctx, "dom.query", object{"selector": args["selector"]}, args, era)
			if err != nil {
				return nil, err
			}
			if !response.boolean("ok") {
				return mcpResponse(response, "dom.query", object{}), nil
			}
			var nodes []object
			_ = json.Unmarshal(response.object("result")["nodes"], &nodes)
			if len(nodes) == 0 {
				return mcpErrorResult("INVALID_REQUEST", "No element found for selector "+args.text("selector")), nil
			}
			elementRef = nodes[0].text("elementRef")
		}
		if strings.HasPrefix(method, "patch.") {
			params["target"] = value(object{"elementRef": value(elementRef)})
		} else {
			params["elementRef"] = value(elementRef)
		}
	}
	if method == "patch.apply_dom" && name == "browser_patch" {
		aliases := map[string]string{"setAttribute": "set_attribute", "removeAttribute": "remove_attribute", "addClass": "add_class", "removeClass": "remove_class", "toggleClass": "toggle_class", "setTextContent": "set_text"}
		if normalized := aliases[params.text("operation")]; normalized != "" {
			params["operation"] = value(normalized)
		}
		if strings.HasSuffix(params.text("operation"), "_class") && params["value"] == nil {
			params["value"] = args["name"]
		}
	}
	if method == "artifact.read" && name == "browser_artifact" && params["offset"] == nil {
		params["offset"] = value(0)
	}
	if preset := args.text("budgetPreset"); preset != "" {
		for k, v := range catalog.Presets[preset][method] {
			if params[k] == nil {
				params[k] = v
			}
		}
	}
	response, err := s.bridge(ctx, method, params, args, era)
	if err != nil {
		return nil, err
	}
	if name == "browser_capture" && strings.HasPrefix(method, "cdp.") && response.boolean("ok") {
		data, truncated := mcpBoundValue(response["result"], 500, 50000, 4000, true)
		return mcpResult("Captured bounded structured data from "+method+".", object{"ok": value(true), "method": value(method), "data": data, "truncated": value(truncated)}, false), nil
	}
	return mcpResponse(response, method, params), nil
}

func mcpValidateAction(name, method string, params, args object) string {
	if name == "browser_call" {
		return ""
	}
	required := map[string]string{"dom.find_by_text": "text", "dom.find_by_role": "role", "dom.baseline.compare": "baselineId", "dom.baseline.describe": "baselineId", "dom.baseline.release": "baselineId", "page.evaluate": "expression", "navigation.navigate": "url", "patch.apply_dom": "operation", "patch.rollback": "patchId", "artifact.read": "artifactId", "artifact.delete": "artifactId", "network.intercept.add": "urlPattern", "network.intercept.remove": "ruleId", "input.type": "text", "input.press_key": "key", "cdp.dispatch_key_event": "key"}
	if key := required[method]; key != "" && strings.TrimSpace(params.text(key)) == "" {
		return key + " is required for " + method + "."
	}
	if method == "dom.wait_for" && strings.TrimSpace(params.text("selector")) == "" && strings.TrimSpace(params.text("text")) == "" {
		return "selector or text is required for dom.wait_for."
	}
	if method == "input.fill" && params["value"] == nil {
		return "value is required for input.fill."
	}
	if method == "input.select_option" {
		found := false
		for _, key := range []string{"values", "labels", "indexes"} {
			var entries []json.RawMessage
			if json.Unmarshal(params[key], &entries) == nil && len(entries) > 0 {
				found = true
			}
		}
		if !found {
			return "values, labels, or indexes are required."
		}
	}
	if (method == "tabs.close" || method == "tabs.activate") && args.number("tabId") <= 0 {
		return "tabId is required for " + method + "."
	}
	if method == "layout.hit_test" && (params["x"] == nil || params["y"] == nil) {
		return "x and y are required for layout.hit_test."
	}
	if (method == "cdp.get_box_model" || method == "cdp.get_computed_styles_for_node") && !mcpIsNumber(params["nodeId"]) {
		return "nodeId must be a finite number."
	}
	if method == "viewport.resize" && !params.boolean("reset") && (params["width"] == nil || params["height"] == nil) {
		return "width and height are required unless reset=true."
	}
	if method == "patch.apply_styles" && len(params.object("declarations")) == 0 {
		return "declarations are required for patch.apply_styles."
	}
	return ""
}

func mcpHasTarget(args object) bool {
	return args.text("extensionId") != "" || args.text("targetBrowser") != "" || args.text("targetProfile") != ""
}

func (s *mcpSession) bridge(ctx context.Context, method string, params, args object, era string) (object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if method == "page.extract_content" {
		return s.extractContent(ctx, params, args, era)
	}
	if method == "tabs.list" {
		for _, key := range []string{"limit", "offset"} {
			if raw := params[key]; raw != nil {
				schema := object{"type": value("integer"), "minimum": value(0)}
				if key == "limit" {
					schema["minimum"], schema["maximum"] = value(1), value(100)
				}
				if err := validateSchema(raw, schema, "tabs.list "+key); err != nil {
					return failure("", "INVALID_REQUEST", err.Error()), nil
				}
			}
		}
	}
	if method == "tabs.list" && !mcpHasTarget(args) && !args.boolean("_skipProfileDiscovery") {
		return s.profileTabs(ctx, params, args, era)
	}
	s.mu.Lock()
	if s.agentSession == "" {
		s.agentSession = "mcp_" + uniqueID()
	}
	agentSession := s.agentSession
	s.mu.Unlock()
	meta := object{"source": value("mcp"), "mcp_era": value(era), "agent_session": value(agentSession)}
	for key, dest := range map[string]string{"extensionId": "target_extension", "targetBrowser": "target_browser", "targetProfile": "target_profile"} {
		if v, ok := args[key]; ok {
			meta[dest] = v
		}
	}
	if !strings.HasPrefix(method, "screenshot.") && !strings.HasPrefix(method, "webmcp.") && method != "sensitive.read" {
		budgets := map[string]int{"quick": 500, "normal": 1500, "deep": 4000}
		if budget := budgets[args.text("budgetPreset")]; budget != 0 {
			meta["token_budget"] = value(budget)
		}
	}
	if args.boolean("_clearTokenBudget") {
		meta["token_budget"] = value[*int](nil)
	}
	return s.requestWithRetry(ctx, method, params, meta, args)
}

func (s *mcpSession) batch(ctx context.Context, args object, era string) (object, error) {
	var calls []object
	if json.Unmarshal(args["calls"], &calls) != nil || len(calls) == 0 || len(calls) > 20 {
		return mcpErrorResult("INVALID_REQUEST", "calls must contain 1 to 20 entries."), nil
	}
	for _, call := range calls {
		if !batchSafe(call.text("method"), call.object("params")) {
			return mcpErrorResult("INVALID_REQUEST", call.text("method")+" is not safe for parallel batch execution."), nil
		}
	}
	results := make([]object, len(calls))
	jobs := make(chan int, len(calls))
	var workers sync.WaitGroup
	for i := range calls {
		jobs <- i
	}
	close(jobs)
	for worker := 0; worker < 5; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := range jobs {
				call := calls[i]
				if !catalog.Methods[call.text("method")].boolean("tab") {
					delete(call, "tabId")
				}
				for _, key := range []string{"extensionId", "targetBrowser", "targetProfile"} {
					if call[key] == nil && args[key] != nil {
						call[key] = args[key]
					}
				}
				method := call.text("method")
				params := mcpClone(call.object("params"))
				for key, v := range catalog.Presets[call.text("budgetPreset")][method] {
					if params[key] == nil {
						params[key] = v
					}
				}
				start := time.Now()
				response, err := s.bridge(ctx, method, params, call, era)
				item := cliBatchResult(method, call.number("tabId"), response, err, time.Since(start).Milliseconds(), time.Now().UnixMilli())
				delete(item, "response")
				item["meta"] = value(mcpPick(item.object("meta"), "protocol_version protocol_warning budget_truncated continuation_hint"))
				if err != nil {
					failure := mcpErrorResult("INTERNAL_ERROR", err.Error()).object("structuredContent")
					for _, key := range []string{"evidence", "error", "recovery", "outputTruncated"} {
						if failure[key] != nil {
							item[key] = failure[key]
						}
					}
					item["summary"] = value("INTERNAL_ERROR: " + err.Error())
					if hint := failure.object("recovery").text("hint"); hint != "" {
						item["summary"] = value(item.text("summary") + " " + hint)
					}
				}
				if method == "tabs.list" && err == nil {
					discovery := mcpResponse(response, method, params).object("structuredContent")
					for _, key := range []string{"summary", "evidence", "pagination", "outputTruncated"} {
						if discovery[key] != nil {
							item[key] = discovery[key]
						}
					}
				}
				item["destinationId"] = value[*string](nil)
				if call["destinationId"] != nil {
					item["destinationId"] = call["destinationId"]
				}
				item["tabId"] = value[*int](nil)
				if call["tabId"] != nil {
					item["tabId"] = call["tabId"]
				}
				if call["extensionId"] != nil {
					item["extensionId"] = call["extensionId"]
				}
				results[i] = item
			}
		}()
	}
	workers.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	failures := 0
	for _, result := range results {
		if !result.boolean("ok") {
			failures++
		}
	}
	summary := fmt.Sprintf("Batch executed %d call(s).", len(calls))
	if failures > 0 {
		summary = fmt.Sprintf("Batch executed %d call(s) with %d error(s).", len(calls), failures)
	}
	return mcpResult(summary, object{"ok": value(failures == 0), "successCount": value(len(calls) - failures), "failureCount": value(failures), "compactOutput": value(true), "results": value(results)}, failures > 0), nil
}

func (s *mcpSession) investigate(ctx context.Context, args object, era string) (object, error) {
	objective := strings.TrimSpace(args.text("objective"))
	if objective == "" {
		return mcpErrorResult("INVALID_REQUEST", "objective is required for browser_investigate."), nil
	}
	scope := args.text("scope")
	if scope == "" {
		scope = "normal"
	}
	settings := map[string][]int{"quick": {10, 2, 300, 0}, "normal": {25, 4, 600, 4000}, "deep": {50, 6, 1000, 8000}}[scope]
	if settings == nil {
		return mcpErrorResult("INVALID_REQUEST", "Unsupported investigation scope."), nil
	}
	selector := args.text("selector")
	if selector == "" {
		selector = "body"
	}
	methods := []string{"page.get_state", "dom.query"}
	params := []object{{}, {"selector": value(selector), "maxNodes": value(settings[0]), "maxDepth": value(settings[1]), "textBudget": value(settings[2])}}
	if settings[3] > 0 {
		methods = append(methods, "page.get_text")
		params = append(params, object{"textBudget": value(settings[3])})
	}
	if scope == "deep" {
		methods = append(methods, "page.get_console", "page.get_network")
		params = append(params, object{"level": value("warn"), "limit": value(20)}, object{"limit": value(20)})
	}
	steps, failed := []object{}, []object{}
	for i, method := range methods {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		start := time.Now()
		response, err := s.bridge(ctx, method, params[i], args, era)
		var result object
		if err != nil {
			result = object{"ok": value(false), "summary": value("ERROR: " + err.Error()), "evidence": value[*string](nil)}
		} else {
			result = cliSummaryNow(response, method)
		}
		step := mcpPick(result, "ok summary evidence")
		step["method"], step["durationMs"] = value(method), value(time.Since(start).Milliseconds())
		steps = append(steps, step)
		if !step.boolean("ok") {
			failed = append(failed, step)
		}
	}
	return mcpResult(fmt.Sprintf("Investigation complete (%s, %d steps). Objective: %s", scope, len(steps), objective), object{"ok": value(len(failed) == 0), "objective": value(objective), "scope": value(scope), "heuristicFallback": value(true), "steps": value(steps), "failedSteps": value(failed)}, len(failed) > 0), nil
}
