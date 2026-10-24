package bridge

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCLISummaryRecordEvidencePreservesObjectAndNonObjectShapes(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{
		{` {"z":"last","a":"\u003cfirst\u003e"} `, `{"a":"\u003cfirst\u003e","z":"last"}`},
		{`["a","b"]`, `{"0":"a","1":"b"}`},
		{`"text"`, `{}`},
		{`null`, `{}`},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			response := object{"ok": value(true), "result": json.RawMessage(tc.raw)}
			got := cliSummaryNow(response, "dom.get_attributes")
			assertJSONEqual(t, got["evidence"], json.RawMessage(tc.want))
		})
	}
}

func BenchmarkCLISummaryDiscardedRecord(b *testing.B) {
	response := success("summary", object{
		"nodes": value([]object{{"elementRef": value("el_test_1"), "tag": value("div"), "attrs": value(object{"data-large": value(strings.Repeat("x", 100000))})}}),
	})
	b.ReportAllocs()
	for b.Loop() {
		if !cliSummaryNow(response, "dom.query").boolean("ok") {
			b.Fatal("summary failed")
		}
	}
}
