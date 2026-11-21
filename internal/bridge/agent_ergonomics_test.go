package bridge

import (
	"strings"
	"testing"
)

func TestUnknownMethodSuggestsTheClosestCatalogMethod(t *testing.T) {
	for method, want := range map[string]string{
		"page.navigate":   "navigation.navigate",
		"tabs.navigate":   "navigation.navigate",
		"page.goto":       "navigation.navigate",
		"dom.get_txt":     "dom.get_text",
		"dom.click":       "input.click",
		"page.reload":     "navigation.reload",
		"input.select":    "input.select_option",
		"page.screenshot": "screenshot.capture_region",
	} {
		if got := suggestMethod(method); got != want {
			t.Errorf("suggestMethod(%q) = %q, want %q", method, got, want)
		}
	}
	if message := unknownMethodMessage("page.navigate"); !strings.Contains(message, "Did you mean navigation.navigate?") {
		t.Fatalf("message lacks the suggestion: %s", message)
	}
	if message := unknownMethodMessage("zzzz"); !strings.Contains(message, "protocol.describe") {
		t.Fatalf("message without a near match lacks discovery guidance: %s", message)
	}
}

func TestDestinationStatusSummaryNamesTheBlockingFact(t *testing.T) {
	ready := object{"reachable": value(true), "extensionConnected": value(true), "accessEnabled": value(true)}
	restricted := mcpClone(ready)
	restricted["routeReady"], restricted["routeReason"] = value(false), value("restricted_page")
	if got := destinationStatusSummary("vm", restricted); !strings.Contains(got, "restricted page") || !strings.Contains(got, "create a tab") {
		t.Fatalf("restricted route summary: %s", got)
	}
	disabled := mcpClone(ready)
	disabled["accessEnabled"] = value(false)
	if got := destinationStatusSummary("vm", disabled); !strings.Contains(got, "access is disabled") {
		t.Fatalf("disabled access summary: %s", got)
	}
	if got := destinationStatusSummary("vm", object{}); !strings.Contains(got, "not reachable") {
		t.Fatalf("unreachable summary: %s", got)
	}
}

func TestMCPErrorTextKeepsActionableDetails(t *testing.T) {
	details := value(object{
		"completed": value(0),
		"elapsedMs": value(17),
		"failedStep": value(object{
			"code": value("INPUT_INVALID_TARGET"),
			"details": value(object{
				"aftermath":  value(object{"dispatch": value("uncertain"), "observation": value(object{"status": value("not_requested")})}),
				"elementRef": value("el_1"),
				"resolution": value(object{"candidateCount": value(1), "strategy": value("locator-first")}),
			}),
		}),
	})
	text := mcpErrorDetailsText(details)
	if strings.Contains(text, "aftermath") || strings.Contains(text, "elapsedMs") {
		t.Fatalf("error text kept diagnostic noise: %s", text)
	}
	if !strings.Contains(text, "locator-first") || !strings.Contains(text, "el_1") {
		t.Fatalf("error text lost the resolution: %s", text)
	}
}

func TestDOMQuerySummaryDescribesListedMatches(t *testing.T) {
	if got := domQuerySummary(2, 2, 2); !strings.Contains(got, "all are listed") {
		t.Fatalf("complete listing: %s", got)
	}
	if got := domQuerySummary(25, 40, 25); !strings.Contains(got, "listed the first 25") {
		t.Fatalf("partial listing: %s", got)
	}
	if got := domQuerySummary(3, 2, -1); !strings.Contains(got, "only the first match's subtree") {
		t.Fatalf("legacy extension result: %s", got)
	}
	compact := mcpResponse(success("q", object{"nodes": value([]object{{"elementRef": value("el_1"), "tag": value("input"), "checked": value(true), "attrs": value(object{})}}), "matchCount": value(1)}), "dom.query", object{}).object("structuredContent")
	if !strings.Contains(string(compact["evidence"]), `"checked":true`) {
		t.Fatalf("MCP evidence dropped checked state: %s", compact["evidence"])
	}
}

func TestBrowserCallFoldsMethodParamsWrittenBesideMethod(t *testing.T) {
	properties := object{"method": value(object{}), "params": value(object{}), "tabId": value(object{})}
	folded := foldBrowserCallArguments(object{
		"method":           value("input.perform"),
		"tabId":            value(7),
		"returnLastResult": value(true),
		"steps":            value([]object{}),
		"params":           value(object{"steps": value([]object{{"method": value("input.click")}})}),
	}, properties)
	if folded["returnLastResult"] != nil || folded["steps"] != nil || folded.text("method") != "input.perform" || folded.number("tabId") != 7 {
		t.Fatalf("folded arguments: %s", value(folded))
	}
	params := folded.object("params")
	if !params.boolean("returnLastResult") || !strings.Contains(string(params["steps"]), "input.click") {
		t.Fatalf("folded params: %s", value(params))
	}
}
