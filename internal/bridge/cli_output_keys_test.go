package bridge

import (
	"bytes"
	"encoding/json"
	"reflect"
	"sort"
	"strconv"
	"testing"
)

func TestCLIArrayIndex(t *testing.T) {
	for _, tc := range []struct {
		key   string
		index uint64
		valid bool
	}{
		{"0", 0, true}, {"2", 2, true}, {"4294967294", 4294967294, true},
		{"", 0, false}, {"00", 0, false}, {"01", 0, false}, {"+1", 0, false},
		{"-1", 0, false}, {"1.0", 0, false}, {"1e2", 0, false}, {" 1", 0, false},
		{"field", 0, false}, {"4294967295", 0, false}, {"99999999999", 0, false},
	} {
		index, valid := cliArrayIndex(tc.key)
		if valid != tc.valid || valid && index != tc.index {
			t.Errorf("cliArrayIndex(%q) = %d, %v; want %d, %v", tc.key, index, valid, tc.index, tc.valid)
		}
	}
}

// Compare the optimized key scan with the original decoder, including decoded
// duplicate names and JavaScript's array-index ordering.
func FuzzCLIObjectKeys(f *testing.F) {
	for _, raw := range []string{
		`{}`, `{"z":0,"10":10,"2":2,"01":1,"4294967295":3,"0":4}`,
		`{"a":1,"\u0061":2,"nested":{"a":[1,{"quoted":"}\\\""}]},"last":null}`,
		`{"\ud800":1,"\ufffd":2,"café":3,"😀":4}`,
		`{"01":1,"4294967294":2,"4294967295":3,"-0":4,"1.0":5,"1e0":6}`,
	} {
		f.Add(raw)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		if _, err := decodeObject([]byte(raw)); err != nil {
			return
		}
		dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
		_, _ = dec.Token()
		want := []string{}
		seen := map[string]bool{}
		for dec.More() {
			token, err := dec.Token()
			if err != nil {
				t.Fatal(err)
			}
			key, ok := token.(string)
			if !ok {
				t.Fatal("object key is not a string")
			}
			var value json.RawMessage
			if err := dec.Decode(&value); err != nil {
				t.Fatal(err)
			}
			if !seen[key] {
				seen[key] = true
				want = append(want, key)
			}
		}
		sort.SliceStable(want, func(i, j int) bool {
			a, ea := strconv.ParseUint(want[i], 10, 32)
			b, eb := strconv.ParseUint(want[j], 10, 32)
			ai := ea == nil && a < 4294967295 && strconv.FormatUint(a, 10) == want[i]
			bi := eb == nil && b < 4294967295 && strconv.FormatUint(b, 10) == want[j]
			if ai && bi {
				return a < b
			}
			return ai && !bi
		})
		if got := cliObjectKeys([]byte(raw)); !reflect.DeepEqual(got, want) {
			t.Fatalf("keys = %q, want %q", got, want)
		}
	})
}
