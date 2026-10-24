package bridge

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMCPDeliveredSizeMatchesCanonicalEnvelope(t *testing.T) {
	for _, isError := range []bool{false, true} {
		for _, raw := range []string{
			`{"ok":true,"evidence":{"text":"<>&雪😀\n\u0000","numbers":[7.0,7e0,-0,1e-7,1e21]}}`,
			`{"ok":true,"evidence":{"duplicate":1,"duplicate":2,"surrogate":"\ud800"}}`,
			`null`,
		} {
			var structured object
			if err := json.Unmarshal([]byte(raw), &structured); err != nil {
				t.Fatal(err)
			}
			images := []object{{"type": value("image"), "data": value("abc+/="), "mimeType": value("image/png")}}
			result := mcpResult("Summary <>&雪😀\n", structured, isError, images...)
			envelope := mcpClone(result)
			for _, key := range []string{"deliveredBytes", "deliveredTokens", "deliveredCostClass"} {
				if _, exists := structured[key]; exists {
					t.Fatal("result mutated the caller's structured payload")
				}
			}
			envelope["structuredContent"] = value(structured)
			size := len(cliJSON(value(envelope), false))
			got := result.object("structuredContent")
			if got.number("deliveredBytes") != int64(size) || got.number("deliveredTokens") != int64((size+3)/4) {
				t.Fatalf("incorrect metrics for error=%t %s: %s, want %d bytes", isError, raw, value(got), size)
			}
		}
	}
}

func BenchmarkMCPResultAccounting(b *testing.B) {
	structured := object{"ok": value(true), "evidence": value(object{"text": value(strings.Repeat("Browser <>&雪😀\n", 4096))})}
	for _, mode := range []string{"envelope-format", "current"} {
		b.Run(mode, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if mode == "current" {
					_ = mcpResult("Read page", structured, false)
					continue
				}
				// Previous accounting path, retained only as a benchmark baseline.
				content := []object{{"type": value("text"), "text": value("Read page")}}
				result := object{"content": value(content), "structuredContent": value(structured)}
				size := len(cliJSON(value(result), false))
				tokens := (size + 3) / 4
				out := mcpClone(structured)
				out["deliveredBytes"], out["deliveredTokens"], out["deliveredCostClass"] = value(size), value(tokens), value(mcpCost(tokens))
				result["structuredContent"] = value(out)
			}
		})
	}
}
