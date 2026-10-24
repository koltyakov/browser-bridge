package bridge

import (
	"encoding/json"
	"strings"
	"testing"
)

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
