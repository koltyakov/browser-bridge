package bridge

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCLIConsoleSummaryShowsTopFrame(t *testing.T) {
	entries := []object{
		{"level": value("exception"), "args": value([]string{"Error: boom"}), "ts": value(1700000000000), "stack": value([]object{
			{"function": value("n"), "url": value("https://app.test/assets/app.js"), "line": value(1), "column": value(47), "source": value(object{
				"file": value("webpack://shop/./src/alpha.ts"), "path": value("src/alpha.ts"), "line": value(6), "column": value(5),
			})},
			{"url": value("https://app.test/assets/app.js"), "line": value(1), "column": value(90)},
		})},
		{"level": value("error"), "args": value([]string{"unmapped"}), "ts": value(1700000000000), "stack": value([]object{
			{"url": value("https://app.test/assets/app.js"), "line": value(2), "column": value(3), "sourceUnavailable": value("no_source_map")},
		})},
		{"level": value("log"), "args": value([]string{"no stack"}), "ts": value(1700000000000)},
		{"level": value("error"), "args": value([]string{"forged"}), "ts": value(1700000000000), "stack": value("not frames")},
		{"level": value("error"), "args": value([]string{"partial"}), "ts": value(1700000000000), "stack": value([]object{{"url": value("https://x.test/a.js")}})},
	}
	response := success("console", object{"entries": value(entries), "count": value(len(entries)), "total": value(len(entries))})
	summary := cliSummarize(response, "page.get_console", 1700000000000)
	var evidence []object
	if err := json.Unmarshal(summary["evidence"], &evidence); err != nil {
		t.Fatalf("evidence: %v %s", err, value(summary))
	}
	want := []string{"n (src/alpha.ts:6:5)", "https://app.test/assets/app.js:2:3", "", "", ""}
	for i, expected := range want {
		if got := evidence[i].text("at"); got != expected {
			t.Errorf("entry %d at = %q, want %q", i, got, expected)
		}
		if expected == "" && evidence[i]["at"] != nil {
			t.Errorf("entry %d should omit at: %s", i, value(evidence[i]))
		}
	}
}

func TestCLIConsoleTopFrameFallsBackToFileAndBoundsText(t *testing.T) {
	frame := object{"function": value(strings.Repeat("f", 500)), "url": value("https://app.test/a.js"), "line": value(1), "column": value(2), "source": value(object{
		"file": value("https://app.test/src/a.ts"), "line": value(3), "column": value(4),
	})}
	at := cliConsoleTopFrame(object{"stack": value([]object{frame})})
	if !strings.HasSuffix(at, " (https://app.test/src/a.ts:3:4)") || len(at) > 500 {
		t.Fatalf("top frame = %q", at)
	}
	// A source without a usable position keeps the generated location.
	frame["source"] = value(object{"path": value("src/a.ts")})
	frame["function"] = value("")
	if at := cliConsoleTopFrame(object{"stack": value([]object{frame})}); at != "https://app.test/a.js:1:2" {
		t.Fatalf("top frame = %q", at)
	}
}

func TestMCPConsoleForwardsResolveSources(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object {
		return success(request.text("id"), object{"entries": value([]object{}), "count": value(0), "total": value(0)})
	})
	s := &mcpSession{config: c, agentSession: "console-resolve-test"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := s.handleTool(ctx, "browser_page", object{
		"action": value("console"), "level": value("error"), "resolveSources": value(true), "tabId": value(7),
	}, "modern")
	if err != nil || result.boolean("isError") {
		t.Fatalf("MCP call failed: %v %s", err, value(result))
	}
	select {
	case request := <-requests:
		params := request.object("params")
		if request.text("method") != "page.get_console" || string(params["resolveSources"]) != "true" || params.text("level") != "error" {
			t.Fatalf("MCP did not forward resolveSources: %s", value(request))
		}
	case <-ctx.Done():
		t.Fatal("MCP did not forward the request")
	}
}

func TestMCPConsoleEvidenceKeepsResolvedStacks(t *testing.T) {
	frames := make([]object, 8)
	for i := range frames {
		frames[i] = object{"function": value("fn"), "url": value("https://app.test/assets/app.js"), "line": value(1), "column": value(i + 1), "source": value(object{
			"file": value("webpack://shop/./src/a.ts"), "path": value("src/a.ts"), "line": value(i + 1), "column": value(1), "name": value("handler"),
		})}
	}
	entries := make([]object, 10)
	for i := range entries {
		entries[i] = object{"level": value("exception"), "args": value([]string{"Error: boom"}), "ts": value(1), "stack": value(frames)}
	}
	response := success("console", object{"entries": value(entries), "count": value(len(entries)), "total": value(len(entries))})
	structured := mcpResponse(response, "page.get_console", object{"limit": value(10)}).object("structuredContent")
	text := string(structured["evidence"])
	if strings.Contains(text, "[truncated]") || strings.Count(text, `"path":"src/a.ts"`) != 80 {
		t.Fatalf("resolved stacks were cut: %s", text)
	}
}
