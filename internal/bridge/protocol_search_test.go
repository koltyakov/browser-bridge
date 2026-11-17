package bridge

import (
	"encoding/json"
	"strings"
	"testing"
)

func searchMatches(t *testing.T, result object) []object {
	t.Helper()
	if result.text("error") != "" {
		t.Fatalf("search failed: %s", value(result))
	}
	var matches []object
	if err := json.Unmarshal(result["matches"], &matches); err != nil {
		t.Fatal(err)
	}
	return matches
}

func TestRPCSearchIsBoundedRankedAndLiteral(t *testing.T) {
	exact := searchMatches(t, searchMethods(object{"query": value("INPUT.FILL")}))
	if len(exact) == 0 || exact[0].text("method") != "input.fill" {
		t.Fatalf("exact method was not ranked first: %s", value(exact))
	}
	if len(searchMatches(t, searchMethods(object{"query": value(".*")}))) != 0 {
		t.Fatal("query was treated as a regular expression")
	}
	all := searchMatches(t, searchMethods(object{"query": value("input"), "limit": value(20)}))
	first := searchMethods(object{"query": value("input"), "limit": value(2)})
	a := searchMatches(t, first)
	b := searchMatches(t, searchMethods(object{"query": value("input"), "limit": value(2), "offset": first.object("pagination")["nextOffset"]}))
	if len(a) != 2 || len(b) != 2 || a[0].text("method") == b[0].text("method") || len(all) < 4 {
		t.Fatal("pagination overlapped or lost results")
	}
	for _, match := range all {
		if !strings.Contains(match.text("signature"), `call(method: "`+match.text("method")+`"`) ||
			match.object("invocation").text("tool") != "browser_call" ||
			match["inputSchema"] != nil || match["example"] != nil {
			t.Fatalf("invalid search detail: %s", value(match))
		}
	}
	filtered := searchMatches(t, searchMethods(object{"query": value("read"), "group": value("session")}))
	for _, match := range filtered {
		if match.text("group") != "session" {
			t.Fatal("group filter leaked")
		}
	}
}

func TestRPCSearchRejectsMalformedAndConflictingOptions(t *testing.T) {
	for _, params := range []object{
		{"query": value("")}, {"query": value(4)}, {"query": value(strings.Repeat("a", 257))},
		{"query": value("input"), "method": value("input.fill")},
		{"query": value("input"), "group": value("missing")},
		{"query": value("input"), "limit": value(0)},
		{"query": value("input"), "limit": value(21)},
		{"query": value("input"), "offset": value(-1)},
		{"query": value("input"), "offset": value(1.5)},
		{"query": value("input"), "offset": value[*int](nil)},
	} {
		if searchMethods(params).text("error") == "" || !mcpDescribe(params).boolean("isError") {
			t.Fatalf("malformed options accepted: %s", value(params))
		}
	}
}

func TestRPCDiscoveryKeepsStartupCompactAndSharesCanonicalSignatures(t *testing.T) {
	if len(catalog.MethodInputs) != len(catalog.Methods) {
		t.Fatal("missing canonical RPC input binding")
	}
	params := object{"query": value("fill editable"), "limit": value(3)}
	raw := describe(params)
	mcp := mcpDescribe(params).object("structuredContent")
	if !jsonEqual(raw["matches"], mcp["matches"]) ||
		!jsonEqual(raw["pagination"], mcp["pagination"]) || len(searchMatches(t, raw)) == 0 {
		t.Fatal("CLI and MCP search disagree")
	}
	for _, tool := range catalog.Tools {
		if strings.HasPrefix(tool.text("name"), "input.") || strings.Contains(string(value(tool)), "call(method:") {
			t.Fatal("RPC signatures expanded the startup tool list")
		}
	}
	for _, entry := range catalog.Methods {
		if entry["signature"] != nil || entry["inputSchema"] != nil {
			t.Fatal("signatures leaked into broad discovery")
		}
	}
}
