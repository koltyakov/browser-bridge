package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

func mcpDescribe(params object) object {
	if params["method"] != nil && params["group"] != nil {
		return mcpErrorResult("INVALID_REQUEST", "protocol.describe accepts either method or group, not both.")
	}
	if params["method"] != nil {
		if method, exists := catalog.Methods[params.text("method")]; exists {
			return mcpResult("Bridge protocol description loaded.", method, false)
		}
		return mcpErrorResult("INVALID_REQUEST", "Unknown bridge method: "+params.text("method"))
	}
	groups := map[string][]object{}
	for _, method := range catalog.Methods {
		group := method.text("group")
		groups[group] = append(groups[group], method)
	}
	if params["group"] != nil {
		group := params.text("group")
		methods, exists := groups[group]
		if !exists {
			return mcpErrorResult("INVALID_REQUEST", "Unknown bridge method group: "+group)
		}
		sort.Slice(methods, func(i, j int) bool { return methods[i].text("method") < methods[j].text("method") })
		return mcpResult("Bridge protocol description loaded.", object{"group": value(group), "methods": value(methods)}, false)
	}
	names := []string{}
	for group := range groups {
		names = append(names, group)
	}
	sort.Strings(names)
	counts := []object{}
	for _, group := range names {
		counts = append(counts, object{"group": value(group), "count": value(len(groups[group]))})
	}
	return mcpResult("Bridge protocol description loaded.", object{"groups": value(counts)}, false)
}

func mcpTabPage(tabs []object, params object) object {
	if params["limit"] == nil && params["offset"] == nil {
		return object{"tabs": value(tabs)}
	}
	sort.SliceStable(tabs, func(i, j int) bool {
		return (tabs[i].boolean("working") || tabs[i].boolean("active")) && !tabs[j].boolean("working") && !tabs[j].boolean("active")
	})
	offset := max(0, int(params.number("offset")))
	limit := int(params.number("limit"))
	if limit <= 0 {
		limit = 10
	}
	limit = min(limit, 100)
	start := min(offset, len(tabs))
	end := min(start+limit, len(tabs))
	pagination := object{"totalCount": value(len(tabs)), "returnedCount": value(end - start), "offset": value(offset), "omittedCount": value(len(tabs) - (end - start)), "truncated": value(end-start < len(tabs)), "nextOffset": value[*int](nil)}
	if end < len(tabs) {
		pagination["nextOffset"] = value(end)
	}
	return object{"tabs": value(tabs[start:end]), "pagination": value(pagination)}
}

func (s *mcpSession) profileTabs(ctx context.Context, params, args object, era string) (object, error) {
	health, err := s.bridge(ctx, "health.ping", object{}, args, era)
	if err != nil || !health.boolean("ok") {
		return health, err
	}
	var connected []object
	_ = json.Unmarshal(health.object("result")["connectedExtensions"], &connected)
	profiles := []object{}
	for _, profile := range connected {
		if profile.boolean("accessEnabled") && profile.text("extensionId") != "" {
			profiles = append(profiles, profile)
		}
	}
	if len(profiles) == 0 {
		if len(connected) <= 1 {
			options := mcpClone(args)
			options["_skipProfileDiscovery"] = value(true)
			return s.bridge(ctx, "tabs.list", params, options, era)
		}
		return failure(health.text("id"), "ACCESS_DENIED", "No connected profile has an enabled window. Select an extensionId from connectedExtensions and request access only for that profile."), nil
	}
	tabs, results := []object{}, []object{}
	partial := false
	for _, profile := range profiles {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		options := mcpClone(args)
		options["extensionId"] = profile["extensionId"]
		response, err := s.bridge(ctx, "tabs.list", object{}, options, era)
		record := mcpPick(profile, "extensionId browserName profileLabel")
		if err != nil {
			response = failure("", "INTERNAL_ERROR", err.Error())
		}
		record["ok"] = response["ok"]
		if !response.boolean("ok") {
			record["error"] = response["error"]
			partial = true
		}
		var listed []object
		_ = json.Unmarshal(response.object("result")["tabs"], &listed)
		record["tabCount"] = value(len(listed))
		for _, tab := range listed {
			for k, v := range mcpPick(profile, "extensionId browserName profileLabel") {
				tab[k] = v
			}
			tabs = append(tabs, tab)
		}
		results = append(results, record)
	}
	result := mcpTabPage(tabs, params)
	result["profiles"], result["connectedExtensions"], result["partial"] = value(results), value(connected), value(partial)
	return success(health.text("id"), result), nil
}

func (s *mcpSession) destinations() ([]object, error) {
	remotes, err := readRemoteConfig(s.config)
	if err != nil {
		return nil, err
	}
	destinations := []object{{"id": value("local"), "local": value(true), "host": value[*string](nil), "port": value[*int](nil)}}
	for _, remote := range remotes.Remotes {
		destinations = append(destinations, object{"id": value(remote.ID), "local": value(false), "host": value(remote.Host), "port": value(remote.Port)})
	}
	return destinations, nil
}

func (s *mcpSession) status(ctx context.Context, args object, era string) (object, error) {
	if mcpHasTarget(args) {
		response, err := s.bridge(ctx, "health.ping", object{}, args, era)
		if err != nil {
			return nil, err
		}
		return mcpResponse(response, "health.ping", object{}), nil
	}
	destinations, err := s.destinations()
	if err != nil {
		return nil, err
	}
	requested := args.text("destinationId")
	if requested != "" {
		selected := []object{}
		for _, destination := range destinations {
			if destination.text("id") == requested {
				selected = append(selected, destination)
			}
		}
		if len(selected) == 0 {
			selected = append(selected, object{"id": value(requested), "local": value(false)})
		}
		destinations = selected
	}
	results := []object{}
	issues := []string{}
	report := object{}
	for _, destination := range destinations {
		if destination.boolean("local") {
			report, err = s.doctor(ctx)
			if err != nil {
				return nil, err
			}
			_ = json.Unmarshal(report["issues"], &issues)
			result := mcpClone(destination)
			result["reachable"] = report["daemonReachable"]
			for _, key := range strings.Fields("extensionConnected accessEnabled routeReady routeTabId") {
				result[key] = report[key]
			}
			results = append(results, result)
			continue
		}
		options := mcpClone(args)
		options["destinationId"] = destination["id"]
		response, err := s.bridge(ctx, "health.ping", object{}, options, era)
		if err != nil {
			response = failure("", "INTERNAL_ERROR", err.Error())
		}
		health := response.object("result")
		access := health.object("access")
		reachable := response.boolean("ok") && health.text("daemon") == "ok"
		ready := reachable && access.boolean("routeReady")
		result := mcpClone(destination)
		result["reachable"], result["daemonReachable"], result["extensionConnected"], result["accessEnabled"], result["routeReady"] = value(reachable), value(reachable), value(health.boolean("extensionConnected")), value(access.boolean("enabled")), value(ready)
		result["routeTabId"] = value[*int](nil)
		if access["routeTabId"] != nil {
			result["routeTabId"] = access["routeTabId"]
		}
		if access["reason"] != nil {
			result["routeReason"] = access["reason"]
		}
		result["health"] = value(mcpResponse(response, "health.ping", object{}).object("structuredContent"))
		results = append(results, result)
	}
	if requested != "" && requested != "local" {
		result := results[0]
		out := mcpClone(result)
		out["ok"], out["destination"] = result["routeReady"], value(destinations[0])
		return mcpResult(fmt.Sprintf("Browser Bridge destination %q readiness checked.", requested), out, !result.boolean("routeReady")), nil
	}
	report["issues"] = value(issues)
	summary := "Browser Bridge is ready."
	if len(issues) > 0 {
		summary = fmt.Sprintf("Browser Bridge has %d readiness issue(s).", len(issues))
	}
	return mcpResult(summary, object{"ok": value(len(issues) == 0), "evidence": value(report), "destinations": value(results)}, false), nil
}

func (s *mcpSession) destinationTabs(ctx context.Context, args object, era string) (object, error) {
	destinations, err := s.destinations()
	if err != nil {
		return nil, err
	}
	if len(destinations) == 1 {
		options := mcpClone(args)
		options["destinationId"] = value("local")
		return s.handleTool(ctx, "browser_tabs", options, era)
	}
	tabs, results := []object{}, []object{}
	failures := 0
	for _, destination := range destinations {
		options := mcpClone(args)
		options["destinationId"] = destination["id"]
		response, err := s.bridge(ctx, "tabs.list", object{}, options, era)
		if err != nil {
			response = failure("", "INTERNAL_ERROR", err.Error())
		}
		listed := response.object("result")
		record := object{"destinationId": destination["id"], "ok": value(response.boolean("ok") && !listed.boolean("partial"))}
		if !record.boolean("ok") {
			failures++
		}
		if response["error"] != nil {
			record["error"] = response["error"]
		}
		if listed["profiles"] != nil {
			record["profiles"] = listed["profiles"]
		}
		var destinationTabs []object
		_ = json.Unmarshal(listed["tabs"], &destinationTabs)
		for _, tab := range destinationTabs {
			tab["destinationId"] = destination["id"]
			tabs = append(tabs, tab)
		}
		record["tabs"] = value(destinationTabs)
		results = append(results, record)
	}
	out := mcpTabPage(tabs, mcpPick(args, "limit offset"))
	out["ok"], out["destinations"] = value(failures == 0), value(results)
	return mcpResult(fmt.Sprintf("Listed %d tab(s) across %d destination(s), %d destination error(s).", len(tabs), len(destinations), failures), out, failures == len(destinations) && len(tabs) == 0), nil
}
