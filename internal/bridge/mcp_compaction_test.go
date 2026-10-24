package bridge

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestMCPPatchListDoesNotInheritTenItemCLIPreview(t *testing.T) {
	for _, count := range []int{0, 10, 54, 120} {
		patches := make([]object, count)
		for index := range patches {
			patches[index] = object{"patchId": value(fmt.Sprintf("patch_%d", index)), "kind": value("style"), "elementRef": value(fmt.Sprintf("el_%d", index))}
		}
		for _, raw := range []json.RawMessage{value(patches), value(object{"patches": value(patches)})} {
			response := object{"ok": value(true), "result": raw}
			cli := cliSummaryNow(response, "patch.list")
			if want := cliPatchListSummary(count, min(count, 10)); cli.text("summary") != want {
				t.Fatalf("CLI summary=%q, want %q", cli.text("summary"), want)
			}
			for _, structured := range []object{
				mcpResponse(response, "patch.list", nil).object("structuredContent"),
				mcpBatchResult(response, "patch.list", nil, nil, 0),
			} {
				var delivered []object
				if err := json.Unmarshal(structured["evidence"], &delivered); err != nil {
					t.Fatal(err)
				}
				if len(delivered) != min(count, 100) || structured.boolean("outputTruncated") != (count > 100) {
					t.Fatalf("count=%d, delivered=%d: %s", count, len(delivered), value(structured))
				}
				if got, want := structured.text("summary"), cliPatchListSummary(count, len(delivered)); got != want {
					t.Fatalf("MCP summary=%q, want %q", got, want)
				}
				assertJSONEqual(t, structured["evidence"], value(patches[:min(count, 100)]))
			}
		}
	}
}

func compactionFixture(t *testing.T, raw string) object {
	t.Helper()
	fixture, err := decodeObject(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestMCPEnvelopeOmitsSummarySizeAndIdleTiming(t *testing.T) {
	response := success("timed", compactionFixture(t, `{"x":1,"y":2,"width":3,"height":4}`))
	response["meta"] = value(compactionFixture(t, `{"protocol_version":"`+protocolVersion()+`","timing":{"preparationMs":0,"queueMs":0,"executionMs":2,"totalMs":2,"scheduled":false}}`))
	structured := mcpResponse(response, "layout.get_box_model", object{}).object("structuredContent")
	for _, key := range []string{"summaryBytes", "summaryTokens", "summaryCostClass"} {
		if structured[key] != nil {
			t.Fatalf("MCP envelope kept CLI summary size %s: %s", key, value(structured))
		}
	}
	if structured["deliveredTokens"] == nil || structured["transportTokens"] == nil {
		t.Fatalf("MCP envelope lost delivered or transport cost: %s", value(structured))
	}
	assertJSONEqual(t, structured["timing"], []byte(`{"executionMs":2,"totalMs":2}`))

	response["meta"] = value(compactionFixture(t, `{"timing":{"preparationMs":1,"queueMs":4,"executionMs":2,"totalMs":7,"scheduled":true}}`))
	structured = mcpResponse(response, "layout.get_box_model", object{}).object("structuredContent")
	assertJSONEqual(t, structured["timing"], []byte(`{"preparationMs":1,"queueMs":4,"executionMs":2,"totalMs":7,"scheduled":true}`))
}

func TestMCPEvidenceOmitsEmptyAndRepeatedFields(t *testing.T) {
	for _, tc := range []struct {
		name, method, result, want string
	}{
		{
			"cdp accessibility", "dom.get_accessibility_tree",
			`{"nodes":[{"nodeId":"1","role":"generic","name":"","value":"","childIds":["2"]},{"nodeId":"2","role":"link","name":"Docs","value":"","interactive":true,"semanticInteractive":true}],"total":2,"count":2}`,
			`[{"nodeId":"1","role":"generic","childIds":["2"]},{"nodeId":"2","role":"link","name":"Docs","childIds":[],"interactive":true,"semanticInteractive":true}]`,
		},
		{
			"dom accessibility", "dom.get_accessibility_tree",
			`{"source":"dom","format":"tree","nodes":[{"ref":"el_1","role":"button","name":"","depth":0,"states":[]},{"ref":"el_2","role":"checkbox","name":"Remember","depth":1,"states":["checked"]}],"count":2,"truncated":false}`,
			`[{"ref":"el_1","role":"button","depth":0},{"ref":"el_2","role":"checkbox","name":"Remember","depth":1,"states":["checked"]}]`,
		},
		{
			"find repeats", "dom.find_by_role",
			`{"nodes":[{"elementRef":"el_1","tag":"a","role":"link","name":"Docs","textExcerpt":"Docs"},{"elementRef":"el_2","tag":"a","role":"link","name":"Home","textExcerpt":"Go home"}],"count":2,"scanned":5,"truncated":false,"truncationReason":null}`,
			`{"found":true,"count":2,"scanned":5,"truncated":false,"nodes":[{"ref":"el_1","tag":"a","role":"link","label":"Docs"},{"ref":"el_2","tag":"a","role":"link","label":"Home","text":"Go home"}]}`,
		},
		{
			"query repeats", "dom.query",
			`{"nodes":[{"elementRef":"el_1","tag":"button","attrs":{"aria-label":"Save"},"textExcerpt":"Save"},{"elementRef":"el_2","tag":"button","attrs":{"aria-label":"Close"},"textExcerpt":"x"}]}`,
			`[{"ref":"el_1","tag":"button","label":"Save"},{"ref":"el_2","tag":"button","label":"Close","text":"x"}]`,
		},
		{
			"idle network", "page.get_network",
			`{"entries":[],"count":0,"total":0,"dropped":0,"capture":null,"startedAt":null,"captureState":"instrumented","truncated":false,"truncation":{"reason":null,"limit":50,"omitted":0}}`,
			`{"entries":[],"count":0,"total":0,"dropped":0,"captureState":"instrumented","truncated":false}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			structured := mcpResponse(success("fixture", compactionFixture(t, tc.result)), tc.method, object{}).object("structuredContent")
			assertJSONEqual(t, structured["evidence"], []byte(tc.want))
		})
	}
}

func TestMCPEvidenceKeepsValuesOfUnrecognizedResults(t *testing.T) {
	result := compactionFixture(t, `{"elementRef":"el_1","classes":["nav","active"],"inlineStyle":"color: red"}`)
	structured := mcpResponse(success("rules", result), "styles.get_matched_rules", object{}).object("structuredContent")
	assertJSONEqual(t, structured["evidence"], []byte(`{"elementRef":"el_1","classes":["nav","active"],"inlineStyle":"color: red"}`))
	if !strings.Contains(structured.text("summary"), "3 top-level fields") {
		t.Fatalf("summary changed: %s", structured.text("summary"))
	}
}

func TestMCPHitTestEvidenceKeepsNodeText(t *testing.T) {
	result := compactionFixture(t, `{"elementRef":"el_3","tag":"a","role":null,"name":null,"textExcerpt":"Services","attrs":{},"bbox":{"x":189.375,"y":0,"width":80.5,"height":50}}`)
	structured := mcpResponse(success("hit", result), "layout.hit_test", object{}).object("structuredContent")
	if got := structured.object("evidence").text("text"); got != "Services" {
		t.Fatalf("hit_test text = %q, want Services: %s", got, value(structured))
	}
	if summary := structured.text("summary"); summary != "Element a, Services, 80.5×50." {
		t.Fatalf("hit_test summary = %q", summary)
	}
}

func TestMCPTabListReportsOriginsProfilesAndPaginationOnce(t *testing.T) {
	result := compactionFixture(t, `{
		"tabs":[
			{"extensionId":"a","browserName":"chrome","profileLabel":"Work","tabId":1,"active":true,"title":"Docs","url":"https://docs.test/start","origin":"https://docs.test"},
			{"extensionId":"b","browserName":"chrome","profileLabel":"Home","tabId":2,"active":false,"title":"Blank","url":"about:blank","origin":"null"}
		],
		"profiles":[{"extensionId":"a","browserName":"chrome","profileLabel":"Work","ok":true,"tabCount":1},{"extensionId":"b","browserName":"chrome","profileLabel":"Home","ok":true,"tabCount":1}],
		"partial":false
	}`)
	structured := mcpResponse(success("tabs", result), "tabs.list", object{}).object("structuredContent")
	evidence := structured.object("evidence")
	assertJSONEqual(t, evidence["tabs"], []byte(`[
		{"extensionId":"a","tabId":1,"active":true,"title":"Docs","url":"https://docs.test/start"},
		{"extensionId":"b","tabId":2,"active":false,"title":"Blank","url":"about:blank","origin":"null"}
	]`))
	if evidence["pagination"] != nil || evidence["tabCount"] != nil || evidence["profiles"] == nil {
		t.Fatalf("tab evidence repeated pagination or lost profiles: %s", value(evidence))
	}
	if structured.object("pagination").number("totalCount") != 2 {
		t.Fatalf("top-level pagination missing: %s", value(structured))
	}

	single := compactionFixture(t, `{"tabs":[{"tabId":3,"browserName":"chrome","profileLabel":"Work","url":"https://docs.test/","origin":"https://docs.test"}]}`)
	structured = mcpResponse(success("tabs", single), "tabs.list", object{}).object("structuredContent")
	assertJSONEqual(t, structured.object("evidence")["tabs"], []byte(`[{"tabId":3,"browserName":"chrome","profileLabel":"Work","url":"https://docs.test/"}]`))
}

func TestMCPBatchMetaOmitsUntruncatedBudgetAndRepeatedHints(t *testing.T) {
	response := success("q", compactionFixture(t, `{"nodes":[{"elementRef":"el_1","tag":"a"}]}`))
	response["meta"] = value(compactionFixture(t, `{"protocol_version":"`+protocolVersion()+`","budget_truncated":false,"continuation_hint":null}`))
	if item := mcpBatchResult(response, "dom.query", object{}, nil, 2); item["meta"] != nil {
		t.Fatalf("batch kept empty budget metadata: %s", value(item))
	}

	hint := "The AX result reached maxNodes 10; retry with a larger maxNodes."
	tree := success("ax", compactionFixture(t, `{"nodes":[{"nodeId":"1","role":"link","name":"Docs","childIds":[]}],"rootIds":["1"],"count":1,"total":4,"truncated":true,"continuationHint":"`+hint+`"}`))
	tree["meta"] = value(compactionFixture(t, `{"continuation_hint":"`+hint+`"}`))
	item := mcpBatchResult(tree, "dom.get_accessibility_tree", object{"maxNodes": value(10)}, nil, 2)
	if item["meta"] != nil || item.object("evidenceMeta").text("continuationHint") != hint {
		t.Fatalf("batch repeated the evidence continuation hint: %s", value(item))
	}

	truncated := success("t", compactionFixture(t, `{"text":"abc","length":900,"truncated":true}`))
	truncated["meta"] = value(compactionFixture(t, `{"budget_truncated":true,"continuation_hint":"Retry page.get_text with a larger token budget or tighter params."}`))
	if meta := mcpBatchResult(truncated, "page.get_text", object{}, nil, 2).object("meta"); !meta.boolean("budget_truncated") || meta.text("continuation_hint") == "" {
		t.Fatalf("batch dropped a real budget truncation: %s", value(meta))
	}
}

func TestCLISummaryNamesDOMAccessibilityTrees(t *testing.T) {
	summary := cliSummaryNow(success("tree", compactionFixture(t, `{"source":"dom","format":"tree","count":2,"scanned":9,"truncated":true,"nodes":[{"ref":"el_1","role":"link","name":"","depth":0,"states":[]},{"ref":"el_2","role":"heading","name":"Pricing","depth":1,"states":["level=2"]}]}`)), "dom.get_accessibility_tree")
	if got := summary.text("summary"); got != "Accessibility tree (DOM): 2 node(s), truncated; refs work as input targets." {
		t.Fatalf("DOM tree summarized as %q", got)
	}
	assertJSONEqual(t, summary["evidence"], []byte(`[{"ref":"el_1","role":"link"},{"ref":"el_2","role":"heading","name":"Pricing","states":["level=2"]}]`))
}
