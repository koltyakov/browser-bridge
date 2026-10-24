package bridge

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func mcpContentText(t *testing.T, result object) string {
	t.Helper()
	var content []object
	if err := json.Unmarshal(result["content"], &content); err != nil || len(content) == 0 {
		t.Fatalf("result has no content: %s", value(result))
	}
	return content[0].text("text")
}

func TestMCPErrorTextNamesBoundedDetails(t *testing.T) {
	response := failure("x", "RESULT_TRUNCATED", "The semantic DOM baseline exceeded maxNodes.")
	err := response.object("error")
	err["details"] = value(object{"limit": value("maxNodes"), "maximum": value(60)})
	response["error"] = value(err)
	result := mcpResponse(response, "dom.baseline.create", object{})
	text := mcpContentText(t, result)
	if !strings.HasSuffix(text, ` Details: {"limit":"maxNodes","maximum":60}`) {
		t.Fatalf("error text omits details: %q", text)
	}
	// Structured clients read error.details; the summary does not repeat it.
	if structured := result.object("structuredContent"); strings.Contains(structured.text("summary"), "Details:") {
		t.Fatalf("structured summary repeated details: %s", structured.text("summary"))
	}

	for _, details := range []json.RawMessage{cliNull, value(object{}), value([]string{})} {
		response := failure("x", "ELEMENT_STALE", "Gone")
		err := response.object("error")
		err["details"] = details
		response["error"] = value(err)
		if text := mcpContentText(t, mcpResponse(response, "dom.describe", object{})); strings.Contains(text, "Details:") {
			t.Fatalf("empty details %s rendered: %q", details, text)
		}
	}
}

func TestMCPGeometryRoundsToTenthPixel(t *testing.T) {
	box := mcpResponse(success("b", compactionFixture(t, `{"x":280.875,"y":0,"width":96.703125,"height":60}`)), "layout.get_box_model", object{}).object("structuredContent")
	assertJSONEqual(t, box["evidence"], []byte(`{"x":280.9,"y":0,"width":96.7,"height":60}`))
	if got := box.text("summary"); got != "Box model: 96.7×60 at (280.9, 0)." {
		t.Fatalf("box summary = %q", got)
	}

	described := mcpResponse(success("d", compactionFixture(t, `{"elementRef":"el_c","tag":"a","role":null,"text":"Services","bbox":{"x":280.875,"y":0,"width":96.703125,"height":60}}`)), "dom.describe", object{}).object("structuredContent")
	assertJSONEqual(t, described["evidence"], []byte(`{"elementRef":"el_c","tag":"a","text":"Services","bbox":{"x":280.9,"y":0,"width":96.7,"height":60}}`))
	if got := described.text("summary"); got != "Element a, Services, 96.7×60." {
		t.Fatalf("describe summary = %q", got)
	}
}

func TestMCPPerformShapesFinalReadLikeStandaloneCall(t *testing.T) {
	state := `{"url":"https://docs.test/","origin":"https://docs.test","title":"Docs","readyState":"complete","activeElement":{"elementRef":"el_1","tag":"input","name":null,"role":null},"dialog":{"observable":true,"status":"none"},"selection":{"value":"","truncated":false,"omitted":0},"scroll":{"x":0,"y":600},"viewport":{"width":1200,"height":800}}`
	perform := compactionFixture(t, `{"performed":true,"completed":2,"total":2,"elapsedMs":40,"failures":[],"startedAtMs":[0,20],"lastResult":{"index":1,"method":"page.get_state","byteLength":420,"truncated":false,"result":`+state+`}}`)
	params := compactionFixture(t, `{"steps":[{"method":"viewport.scroll","params":{"top":600}},{"method":"page.get_state"}],"returnLastResult":true}`)
	evidence := mcpResponse(success("p", perform), "input.perform", params).object("structuredContent").object("evidence")
	standalone := mcpResponse(success("s", compactionFixture(t, state)), "page.get_state", object{}).object("structuredContent")
	last := evidence.object("lastResult")
	if !jsonEqual(last["result"], standalone["evidence"]) {
		t.Fatalf("final read differs from standalone evidence:\n%s\n%s", last["result"], standalone["evidence"])
	}
	if last.text("method") != "page.get_state" || last.number("index") != 1 || evidence["failures"] != nil {
		t.Fatalf("perform evidence lost step metadata or kept empty failures: %s", value(evidence))
	}

	// Action results carry outcomes the step result has no other room for.
	click := `{"clicked":true,"elementRef":"el_2","resolution":{"strategy":"elementRef"},"execution":{"actualMode":"dom"}}`
	perform = compactionFixture(t, `{"performed":true,"completed":1,"total":1,"elapsedMs":9,"failures":[{"index":0}],"lastResult":{"index":0,"method":"input.click","result":`+click+`}}`)
	evidence = mcpResponse(success("p", perform), "input.perform", object{}).object("structuredContent").object("evidence")
	assertJSONEqual(t, evidence.object("lastResult")["result"], []byte(click))
	if evidence["failures"] == nil {
		t.Fatalf("perform dropped real failures: %s", value(evidence))
	}
}

func TestMCPNetworkEvidenceOmitsIdleCounters(t *testing.T) {
	result := compactionFixture(t, `{"entries":[],"count":0,"total":0,"filteredTotal":0,"dropped":0,"abandoned":0,"inflight":0,"ownershipHeld":false,"armed":true,"source":"fetch-xhr","captureState":"instrumented","truncated":false}`)
	evidence := mcpResponse(success("n", result), "page.get_network", object{}).object("structuredContent")["evidence"]
	assertJSONEqual(t, evidence, []byte(`{"entries":[],"count":0,"total":0,"dropped":0,"armed":true,"source":"fetch-xhr","captureState":"instrumented","truncated":false}`))

	busy := compactionFixture(t, `{"entries":[],"count":0,"total":5,"filteredTotal":2,"dropped":1,"abandoned":1,"inflight":2,"ownershipHeld":true,"captureState":"armed","truncated":false}`)
	evidence = mcpResponse(success("n", busy), "page.get_network", object{}).object("structuredContent")["evidence"]
	assertJSONEqual(t, evidence, []byte(`{"entries":[],"count":0,"total":5,"filteredTotal":2,"dropped":1,"abandoned":1,"inflight":2,"ownershipHeld":true,"captureState":"armed","truncated":false}`))
}

func TestMCPBatchNamesEveryUnsafeCall(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object { return success(request.text("id"), object{}) })
	s := &mcpSession{config: c, agentSession: "test-session"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	result, err := s.batch(context.Background(), object{"calls": value([]object{
		{"method": value("page.get_state")},
		{"method": value("page.evaluate"), "params": value(object{"expression": value("1")})},
		{"method": value("input.click")},
	})}, "modern")
	if err != nil || !result.boolean("isError") {
		t.Fatalf("batch accepted unsafe calls: %v %s", err, value(result))
	}
	if text := mcpContentText(t, result); !strings.Contains(text, "calls[1] page.evaluate, calls[2] input.click are not safe") {
		t.Fatalf("rejection does not name every unsafe call: %s", text)
	}
	select {
	case request := <-requests:
		t.Fatalf("rejected batch dispatched request: %s", value(request))
	default:
	}
}
