package bridge

import "testing"

func TestTruncatedTextResultsKeepTheContinuationOffset(t *testing.T) {
	response := success("t1", object{"value": value("abcdefghij…"), "truncated": value(true), "omitted": value(990), "length": value(1000), "offset": value(10), "nextOffset": value(19)})
	evidence := mcpResponse(response, "page.get_text", object{"textBudget": value(100)}).object("structuredContent").object("evidence")
	if evidence.number("nextOffset") != 19 || evidence.number("offset") != 10 {
		t.Fatalf("continuation offsets dropped: %s", value(evidence))
	}
}
