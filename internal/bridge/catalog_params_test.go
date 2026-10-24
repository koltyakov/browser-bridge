package bridge

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestParamWarningsSuggestNearMisses(t *testing.T) {
	for _, tc := range []struct {
		method string
		params object
		want   []string
	}{
		{"dom.find_by_role", object{"role": value("link"), "limit": value(5)}, []string{"limit is not a dom.find_by_role param; did you mean maxResults?"}},
		{"dom.query", object{"selector": value("a"), "attributes": value([]string{"href"}), "maxnodes": value(4)}, []string{"attributes is not a dom.query param; did you mean attributeAllowlist?", "maxnodes is not a dom.query param; did you mean maxNodes?"}},
		{"page.evaluate", object{"expression": value("1"), "timeout": value(5)}, []string{"timeout is not a page.evaluate param; did you mean timeoutMs?"}},
		{"input.fill", object{"target": value(object{}), "values": value("x")}, []string{"values is not a input.fill param; did you mean value?"}},
		{"input.perform", object{"steps": value([]object{{"method": value("viewport.scroll"), "params": value(object{"y": value(600)})}})}, []string{"steps[0]: y is not a viewport.scroll param; did you mean top?"}},
		// Declared, preset-injected, internal, and unrelated keys stay quiet.
		{"viewport.scroll", object{"top": value(1), "left": value(2)}, []string{}},
		{"dom.get_accessibility_tree", object{"textBudget": value(300)}, []string{}},
		{"dom.query", object{"_internal": value(true), "frobnicate": value(1), "budget": value(10)}, []string{}},
		{"page.get_state", object{"anything": value(1)}, []string{}},
	} {
		if got := paramWarnings(tc.method, tc.params); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s %s: got %q, want %q", tc.method, value(tc.params), got, tc.want)
		}
	}
}

func TestMisplacedRoutingParam(t *testing.T) {
	if key := misplacedRoutingParam("page.get_state", object{"tabId": value(5)}); key != "tabId" {
		t.Fatalf("tabId inside params was accepted: %q", key)
	}
	if key := misplacedRoutingParam("dom.query", object{"selector": value("a"), "extensionId": value("ext")}); key != "extensionId" {
		t.Fatalf("extensionId inside params was accepted: %q", key)
	}
	for _, method := range []string{"tabs.close", "tabs.activate"} {
		if key := misplacedRoutingParam(method, object{"tabId": value(5)}); key != "" {
			t.Fatalf("%s declares tabId but was rejected", method)
		}
	}
}

func TestMCPCallRejectsRoutingInsideParamsAndWarnsOnNearMisses(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object {
		return success(request.text("id"), object{"found": value(true), "nodes": value([]object{}), "count": value(0)})
	})
	s := &mcpSession{config: c, agentSession: "params-test"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	rejected, err := s.handleTool(context.Background(), "browser_call", object{"method": value("page.get_state"), "params": value(object{"tabId": value(7)})}, "legacy")
	if err != nil || !rejected.boolean("isError") || len(requests) != 0 {
		t.Fatalf("misplaced tabId reached the bridge: %v %s", err, value(rejected))
	}
	if text := mcpText(rejected); !strings.Contains(text, "beside method") {
		t.Fatalf("rejection does not say where tabId belongs: %s", text)
	}
	warned, err := s.handleTool(context.Background(), "browser_call", object{"method": value("dom.find_by_role"), "tabId": value(7), "params": value(object{"role": value("link"), "limit": value(5)})}, "legacy")
	if err != nil || warned.boolean("isError") {
		t.Fatalf("near-miss param failed the call: %v %s", err, value(warned))
	}
	<-requests
	structured := warned.object("structuredContent")
	var warnings []string
	_ = json.Unmarshal(structured["paramWarnings"], &warnings)
	if len(warnings) != 1 || !strings.Contains(mcpText(warned), "did you mean maxResults?") || !strings.Contains(structured.text("summary"), "maxResults") {
		t.Fatalf("near-miss warning missing: %s", value(warned))
	}
	undelivered := mcpClone(structured)
	for _, suffix := range []string{"Bytes", "Tokens", "CostClass"} {
		delete(undelivered, "delivered"+suffix)
	}
	if size := len(cliJSON(value(object{"content": warned["content"], "structuredContent": value(undelivered)}), false)); structured.number("deliveredBytes") != int64(size) {
		t.Fatalf("delivered size ignores the warning: %d vs %d", structured.number("deliveredBytes"), size)
	}
}

func TestMCPBatchPartialFailureKeepsResultsVisible(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object {
		if request.text("method") == "dom.describe" {
			return failure(request.text("id"), "INVALID_REQUEST", "target.elementRef or target.selector is required.")
		}
		return success(request.text("id"), object{"url": value("https://example.test/"), "title": value("Example")})
	})
	s := &mcpSession{config: c, agentSession: "batch-partial"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	result, err := s.batch(context.Background(), object{"calls": value([]object{
		{"method": value("page.get_state"), "tabId": value(4)},
		{"method": value("dom.describe"), "tabId": value(4), "params": value(object{"target": value(object{"role": value("link")})})},
		{"method": value("page.get_text"), "params": value(object{"tabId": value(4)})},
	})}, "legacy")
	if err != nil || result.boolean("isError") {
		t.Fatalf("partial batch failure hid successful results: %v %s", err, value(result))
	}
	if len(requests) != 2 {
		t.Fatalf("misplaced tabId reached the bridge: %d requests", len(requests))
	}
	text := mcpText(result)
	for _, want := range []string{"2 error(s)", "results[1] dom.describe INVALID_REQUEST", "results[2] page.get_text INVALID_REQUEST: tabId inside params"} {
		if !strings.Contains(text, want) {
			t.Fatalf("summary lacks %q: %s", want, text)
		}
	}
	allFailed, _ := s.batch(context.Background(), object{"calls": value([]object{{"method": value("dom.describe"), "tabId": value(4)}})}, "legacy")
	if !allFailed.boolean("isError") {
		t.Fatalf("an all-failed batch should be an error result: %s", value(allFailed))
	}
}

func TestMCPDomQueryKeepsRequestedAttributesAndBoxes(t *testing.T) {
	response := success("q", object{"nodes": value([]object{{
		"elementRef": value("el_1"), "tag": value("a"),
		"attrs": value(object{"href": value("/docs"), "class": value("nav primary"), "rel": value(""), "title": value(strings.Repeat("t", 400))}),
		"bbox":  value(object{"x": value(10.04), "y": value(20.56), "width": value(100.333), "height": value(40)}),
	}})})
	plain := mcpResponse(response, "dom.query", object{"selector": value("a")}).object("structuredContent")
	var nodes []object
	_ = json.Unmarshal(plain["evidence"], &nodes)
	if nodes[0]["attrs"] != nil || nodes[0]["bbox"] != nil {
		t.Fatalf("unrequested attributes or boxes were delivered: %s", value(nodes))
	}
	requested := mcpResponse(response, "dom.query", object{"selector": value("a"), "includeBbox": value(true), "attributeAllowlist": value([]string{"href", "class", "rel", "title", "missing"})}).object("structuredContent")
	_ = json.Unmarshal(requested["evidence"], &nodes)
	attrs := nodes[0].object("attrs")
	if attrs.text("href") != "/docs" || attrs["class"] != nil || !mcpIsString(attrs["rel"]) || len(attrs.text("title")) != 300 || attrs["missing"] != nil || nodes[0].text("cls") != "nav primary" {
		t.Fatalf("allowlisted attributes were not delivered once: %s", value(nodes))
	}
	if !jsonEqual(nodes[0]["bbox"], value(object{"x": value(10), "y": value(20.6), "width": value(100.3), "height": value(40)})) {
		t.Fatalf("requested bbox was not rounded and delivered: %s", nodes[0]["bbox"])
	}
}

func TestMCPDomQuerySkipsBoxesUnlessRequested(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object {
		return success(request.text("id"), object{"nodes": value([]object{})})
	})
	s := &mcpSession{config: c, agentSession: "bbox-test"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	for _, tc := range []struct {
		params object
		want   string
	}{
		{object{"selector": value("a")}, "false"},
		{object{"selector": value("a"), "includeBbox": value(true)}, "true"},
	} {
		if _, err := s.bridge(context.Background(), "dom.query", tc.params, object{}, "legacy"); err != nil {
			t.Fatal(err)
		}
		if got := string((<-requests).object("params")["includeBbox"]); got != tc.want {
			t.Fatalf("includeBbox sent as %s, want %s", got, tc.want)
		}
	}
}

func TestCLIBatchRejectsRoutingInsideParams(t *testing.T) {
	_, invalid, err := prepareCLIBatch([]byte(`[{"method":"page.get_state","params":{"tabId":4}},{"method":"page.get_text"}]`), "")
	if err != nil || len(invalid) != 2 {
		t.Fatalf("misplaced tabId was not rejected: %v %s", err, value(invalid))
	}
	if !strings.Contains(invalid[0].text("summary"), "Set tabId on the batch call") {
		t.Fatalf("rejection does not say where tabId belongs: %s", value(invalid[0]))
	}
}

func mcpText(result object) string {
	var content []object
	_ = json.Unmarshal(result["content"], &content)
	if len(content) == 0 {
		return ""
	}
	return content[0].text("text")
}
