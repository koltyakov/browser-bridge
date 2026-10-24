package bridge

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf16"
)

func BenchmarkMCPBoundArray(b *testing.B) {
	for _, count := range []int{100, 1000, 10000} {
		b.Run(fmt.Sprint(count), func(b *testing.B) {
			raw := json.RawMessage("[" + strings.Repeat(`{"text":"browser evidence","count":123},`, count-1) + `{"text":"last"}]`)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				mcpBound(raw, 500, 20000, 4000)
			}
		})
	}
}

func TestMCPArrayPrefixMatchesDecodedPrefix(t *testing.T) {
	for _, raw := range []json.RawMessage{
		json.RawMessage(`[]`),
		json.RawMessage(`[1,"a]b",{"duplicate":1,"duplicate":2},[true,null],"😀"]`),
		json.RawMessage("[" + strings.Repeat(`"`+strings.Repeat("x", 1024)+`",`, 99) + `"last"]`),
	} {
		var full []json.RawMessage
		if err := json.Unmarshal(raw, &full); err != nil {
			t.Fatal(err)
		}
		for _, limit := range []int{0, 1, 2, 100} {
			prefix, omitted, ok := mcpArrayPrefix(raw, limit)
			if !ok || omitted != (len(full) > limit) {
				t.Fatalf("limit=%d: ok=%v, omitted=%v", limit, ok, omitted)
			}
			assertJSONEqual(t, value(prefix), value(full[:min(limit, len(full))]))
		}
	}
}

func TestMCPArrayPrefixValidatesDiscardedEntries(t *testing.T) {
	for _, raw := range []string{`[1,]`, `[1,{"x":}]`, `[1`, `[1]false`, `[1] ]`, `null`, `{}`} {
		for _, limit := range []int{0, 1, 100} {
			if _, _, ok := mcpArrayPrefix(json.RawMessage(raw), limit); ok {
				t.Fatalf("accepted invalid array %q with limit %d", raw, limit)
			}
		}
	}
}

func TestMCPBoundArrayPreservesBudgets(t *testing.T) {
	for _, tc := range []struct {
		raw, want  string
		entries    int
		characters int
		truncated  bool
	}{
		{`[]`, `[]`, 5, 100, false},
		{`[1,2]`, `[1,2]`, 3, 100, false},
		{`[1,2,3]`, `[1,2]`, 3, 100, true},
		{`[[1,2,3],4,5]`, `[[1,2],"[truncated]","[truncated]"]`, 4, 100, true},
		{`["😀a","b",3]`, `["😀","[truncated]","[truncated]"]`, 10, 2, true},
	} {
		bounded, truncated := mcpBound(json.RawMessage(tc.raw), tc.entries, tc.characters, 4000)
		if truncated != tc.truncated {
			t.Fatalf("%s: truncated=%v, want %v", tc.raw, truncated, tc.truncated)
		}
		assertJSONEqual(t, bounded, json.RawMessage(tc.want))
	}
	raw := json.RawMessage("[" + strings.Repeat("1,", 100) + "1]")
	bounded, truncated := mcpBound(raw, 500, 20000, 4000)
	var items []json.RawMessage
	if err := json.Unmarshal(bounded, &items); err != nil || len(items) != 100 || !truncated {
		t.Fatalf("array cap: count=%d, truncated=%v, err=%v", len(items), truncated, err)
	}
}

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
