package bridge

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestMCPStringBoundsPreserveUTF16Semantics(t *testing.T) {
	for _, text := range []string{"", "plain ASCII", "é漢字", "a😀b🚀", "\xff\xfe😀z"} {
		units := utf16.Encode([]rune(text))
		if got := mcpStringLength(text); got != len(units) {
			t.Fatalf("length(%q)=%d, want %d", text, got, len(units))
		}
		for limit := -1; limit <= len(units)+1; limit++ {
			want := text
			if len(units) > limit {
				want = string(utf16.Decode(units[:max(0, limit)]))
			}
			if got := mcpSlice(text, limit); got != want {
				t.Fatalf("slice(%q,%d)=%q, want %q", text, limit, got, want)
			}
		}
	}
}

func TestMCPBoundStringSurrogateBoundaryAndCapture(t *testing.T) {
	for _, capture := range []bool{false, true} {
		bounded, truncated := mcpBoundValue(value("a😀b"), 10, 100, 2, capture)
		want := "a�"
		if capture {
			want += "[truncated]"
		}
		if !truncated || string(bounded) != string(value(want)) {
			t.Fatalf("capture=%v: %s truncated=%v", capture, bounded, truncated)
		}
	}
}

func BenchmarkMCPStringBounds(b *testing.B) {
	text := strings.Repeat("some text 😀 ", 10000)
	b.Run("length", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if mcpStringLength(text) == 0 {
				b.Fatal("empty length")
			}
		}
	})
	b.Run("prefix", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if mcpSlice(text, 120) == "" {
				b.Fatal("empty prefix")
			}
		}
	})
	b.Run("evidence", func(b *testing.B) {
		raw := value(object{"text": value(text)})
		params := object{"textBudget": value(120)}
		b.ReportAllocs()
		b.ResetTimer()
		for b.Loop() {
			mcpEvidence(raw, "page.get_text", params, nil)
		}
	})
}

func TestMCPBoundOmitsKeysThatExceedCharacterBudget(t *testing.T) {
	for _, key := range []string{strings.Repeat("x", 100000), strings.Repeat("😀", 10001)} {
		raw := value(object{key: value("value")})
		bounded, truncated := mcpBound(raw, 500, 20000, 4000)
		if !truncated || string(bounded) != "{}" {
			t.Fatalf("key with %d UTF-16 units escaped bound: truncated=%v, bytes=%d", mcpStringLength(key), truncated, len(bounded))
		}
	}
}

func TestMCPBoundCountsKeysAgainstRemainingCharacterBudget(t *testing.T) {
	for _, tc := range []struct {
		name, raw, want string
		limit           int
		truncated       bool
	}{
		{"remaining budget", `{"a":"1234","long":"value"}`, `{"a":"1234"}`, 8, true},
		{"nested key", `{"a":{"oversized":"value"}}`, `{"a":{}}`, 8, true},
		{"later key still fits", `{"oversized":"value","z":1}`, `{"z":1}`, 8, true},
		{"supplementary key fits", `{"😀":"ok"}`, `{"😀":"ok"}`, 4, false},
		{"ordinary keys", `{"a":"ok","b":1}`, `{"a":"ok","b":1}`, 8, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bounded, truncated := mcpBound(json.RawMessage(tc.raw), 500, tc.limit, 4000)
			if truncated != tc.truncated {
				t.Fatalf("truncated=%v, want %v", truncated, tc.truncated)
			}
			assertJSONEqual(t, bounded, json.RawMessage(tc.want))
		})
	}
}
