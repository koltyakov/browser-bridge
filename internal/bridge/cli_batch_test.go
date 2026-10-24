package bridge

import (
	"strings"
	"testing"
)

func TestCLIBatchItemsKeepOnlyDistinctFields(t *testing.T) {
	meta := object{
		"protocol_version": value(protocolVersion()), "approx_tokens": value(40), "cost_class": value("cheap"),
		"tab_id": value(12), "active_tab_id": value(12), "tab_routing": value("active"), "debugger_backed": value(false),
		"result_truncated": value(true), "budget_truncated": value(false), "continuation_hint": value("Raise textBudget."),
		"timing": value(object{"executionMs": value(4), "queueMs": value(30), "scheduled": value(true), "totalMs": value(34)}),
	}
	text := strings.Repeat("x", 2000)
	lossy := cliBatchResult("page.get_text", 0, object{"ok": value(true), "result": value(object{"value": value(text), "length": value(2000)}), "meta": value(meta)}, nil, 40, 1700000000000)
	for _, key := range []string{"error", "transportBytes", "summaryTokens"} {
		if _, ok := lossy[key]; ok {
			t.Fatalf("batch item kept redundant %s: %s", key, value(lossy))
		}
	}
	if lossy.object("response").text("value") != text {
		t.Fatalf("bounded evidence dropped the full response: %s", value(lossy))
	}
	if !lossy.object("timing").boolean("scheduled") {
		t.Fatalf("scheduled timing was dropped: %s", value(lossy))
	}
	if got := lossy.object("meta"); !jsonEqual(value(got), value(object{"tab_id": value(12), "result_truncated": value(true), "continuation_hint": value("Raise textBudget.")})) {
		t.Fatalf("meta kept restated fields or lost distinct ones: %s", value(got))
	}
	explicit := cliBatchResult("styles.get_computed", 12, object{"ok": value(true), "result": value(object{"color": value("red")}), "meta": value(object{"tab_id": value(12), "protocol_version": value(protocolVersion())})}, nil, 3, 1700000000000)
	for _, key := range []string{"response", "meta", "timing"} {
		if _, ok := explicit[key]; ok {
			t.Fatalf("batch item kept %s that repeats evidence or the call: %s", key, value(explicit))
		}
	}
}

func TestCLIBatchAcceptsLocalDiscovery(t *testing.T) {
	calls, invalid, err := prepareCLIBatch([]byte(`[{"method":"protocol.describe","params":{"method":"dom.query"}},{"method":"page.get_state","tabId":12}]`), "quick")
	if err != nil || invalid != nil || len(calls) != 2 {
		t.Fatalf("local discovery rejected: %v %s", err, value(invalid))
	}
	if calls[0].text("method") != "protocol.describe" || string(calls[0]["tabId"]) != "null" || calls[1].number("tabId") != 12 {
		t.Fatalf("discovery changed routing: %s", value(calls))
	}
}

func TestCLIBatchEvidenceOnlyFlag(t *testing.T) {
	const calls = `[{"method":"page.get_text"}]`
	request, err := parseCLI([]string{"batch", "--evidence-only", "--preset", "quick", calls})
	if err != nil || !request.boolean("evidenceOnly") || request.text("preset") != "quick" {
		t.Fatalf("evidence-only option rejected: %v %s", err, value(request))
	}
	request, err = parseCLI([]string{"batch", calls})
	if err != nil || request["evidenceOnly"] != nil {
		t.Fatalf("default batch output changed: %v %s", err, value(request))
	}
	for _, args := range [][]string{
		{"batch", "--evidence-only", "--evidence-only", calls},
		{"call", "page.get_text", "--evidence-only"},
	} {
		if _, err := parseCLI(args); err == nil {
			t.Fatalf("invalid flag use accepted: %q", args)
		}
	}
}
