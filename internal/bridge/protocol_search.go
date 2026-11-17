package bridge

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Search only trusted, generated metadata. Page content never enters this index.
// Return RPC signatures, not invented host-specific callable tool paths.
func searchMethods(params object) object {
	query := params.text("query")
	if strings.TrimSpace(query) == "" || len(query) > 256 {
		return object{"error": value("query must be a nonblank string of at most 256 bytes.")}
	}
	if _, exists := params["method"]; exists {
		return object{"error": value("protocol.describe accepts method or query, not both.")}
	}
	group := params.text("group")
	if raw, exists := params["group"]; exists {
		var text string
		if json.Unmarshal(raw, &text) != nil || text == "" {
			return object{"error": value("group must be a nonblank registry group.")}
		}
		found := false
		for _, entry := range catalog.Methods {
			found = found || entry.text("group") == group
		}
		if !found {
			return object{"error": value("Unknown bridge method group: " + group)}
		}
	}
	bound := func(key string, fallback, maximum int) (int, error) {
		raw, exists := params[key]
		if !exists {
			return fallback, nil
		}
		var n int
		minimum := 0
		if key == "limit" {
			minimum = 1
		}
		if string(raw) == "null" || json.Unmarshal(raw, &n) != nil || n < minimum || n > maximum {
			return 0, fmt.Errorf("%s must be an integer in %d..%d", key, minimum, maximum)
		}
		return n, nil
	}
	limit, err := bound("limit", 5, 20)
	if err != nil {
		return object{"error": value(err.Error())}
	}
	offset, err := bound("offset", 0, 10000)
	if err != nil {
		return object{"error": value(err.Error())}
	}
	terms := strings.Fields(strings.ToLower(query))
	type match struct {
		method string
		score  int
	}
	matches := []match{}
	for method, entry := range catalog.Methods {
		if group != "" && entry.text("group") != group {
			continue
		}
		haystack := strings.ToLower(method + " " + entry.text("description") + " " + entry.text("group"))
		matched := true
		for _, term := range terms {
			matched = matched && strings.Contains(haystack, term)
		}
		if !matched {
			continue
		}
		score := 3
		name := strings.ToLower(method)
		needle := strings.ToLower(strings.TrimSpace(query))
		switch {
		case name == needle:
			score = 0
		case strings.HasPrefix(name, needle):
			score = 1
		case strings.Contains(name, needle):
			score = 2
		}
		matches = append(matches, match{method: method, score: score})
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].score != matches[j].score {
			return matches[i].score < matches[j].score
		}
		return matches[i].method < matches[j].method
	})
	start := min(offset, len(matches))
	end := min(start+limit, len(matches))
	results := []object{}
	for _, item := range matches[start:end] {
		entry := catalog.Methods[item.method]
		input := catalog.MethodInputs[item.method]
		results = append(results, object{
			"method": value(item.method), "group": entry["group"], "description": entry["description"],
			"signature": input["signature"], "invocation": input["invocation"],
		})
	}
	var next *int
	if end < len(matches) {
		next = &end
	}
	return object{
		"query": value(query), "matches": value(results),
		"pagination": value(object{"totalCount": value(len(matches)), "offset": value(offset),
			"returnedCount": value(len(results)), "nextOffset": value(next)}),
	}
}
