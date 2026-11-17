package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestMCPDOMTreePreservesActionableEvidenceInSingleAndBatchReads(t *testing.T) {
	nodes := make([]object, 30)
	for i := range nodes {
		nodes[i] = object{"ref": value(fmt.Sprintf("el_%d", i)), "role": value("button"), "name": value(fmt.Sprintf("Action %d", i)), "depth": value(1), "states": value([]string{"expanded"})}
	}
	snapshot := object{"source": value("dom"), "format": value("tree"), "nodes": value(nodes), "count": value(30), "scanned": value(45), "truncated": value(false)}
	params := object{"source": value("dom"), "format": value("tree"), "maxNodes": value(30)}
	single := mcpResponse(success("tree", snapshot), "dom.get_accessibility_tree", params).object("structuredContent")
	if !jsonEqual(single["evidence"], value(nodes)) {
		t.Fatalf("DOM tree lost refs, depth, states, or nodes: %s", single["evidence"])
	}
	if meta := single.object("evidenceMeta"); meta.number("scanned") != 45 || meta.text("format") != "tree" {
		t.Fatalf("DOM traversal metadata missing: %s", value(meta))
	}
	c, _ := mcpTestDaemon(t, func(request object) object { return success(request.text("id"), snapshot) })
	s := &mcpSession{config: c, agentSession: "dom-tree-batch"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	result, err := s.batch(context.Background(), object{"calls": value([]object{{"method": value("dom.get_accessibility_tree"), "params": value(params), "tabId": value(4)}})}, "modern")
	if err != nil || result.boolean("isError") {
		t.Fatalf("batch failed: %v %s", err, value(result))
	}
	var items []object
	if err := json.Unmarshal(result.object("structuredContent")["results"], &items); err != nil || len(items) != 1 {
		t.Fatalf("unexpected batch items: %v %s", err, value(result))
	}
	for _, key := range []string{"evidence", "evidenceMeta"} {
		if !jsonEqual(items[0][key], single[key]) {
			t.Fatalf("batch %s differs from single call: %s", key, value(items[0]))
		}
	}
}

func TestScopedDOMOutlinesPreserveMetadataAcrossCLIAndMCPSingleAndBatch(t *testing.T) {
	for _, format := range []string{"tree", "outline"} {
		t.Run(format, func(t *testing.T) {
			nodes := make([]object, 60)
			lines := make([]string, len(nodes))
			for i := range nodes {
				name := fmt.Sprintf("Save %d %s", i, strings.Repeat("x", 70))
				nodes[i] = object{"ref": value(fmt.Sprintf("el_%d", i)), "role": value("button"), "name": value(name), "depth": value(1), "states": value([]string{}), "matched": value(true)}
				lines[i] = fmt.Sprintf(`  - button "%s" [el_%d] [match]`, name, i)
			}
			scope := object{"requested": value("auto"), "resolved": value("document"), "boundary": value("document"), "frameId": value(7), "scanned": value(100), "fallbackReason": value("main_ambiguous")}
			snapshot := object{
				"source": value("dom"), "format": value(format), "count": value(len(nodes)), "scanned": value(80), "truncated": value(false),
				"scope": value(scope), "completeness": value(object{"complete": value(true), "reasons": value([]string{})}),
				"search": value(object{"query": value("Save"), "context": value(1), "matchCount": value(60), "returnedMatches": value(60)}),
			}
			if format == "tree" {
				snapshot["nodes"] = value(nodes)
			} else {
				snapshot["outline"] = value(strings.Join(lines, "\n"))
			}
			params := object{"source": value("dom"), "format": value(format), "scope": value("auto"), "find": value("Save"), "maxNodes": value(60)}
			response := success("scoped-outline", snapshot)
			cli := cliSummaryNow(response, "dom.get_accessibility_tree")
			cliBatch := cliBatchResult("dom.get_accessibility_tree", 4, response, nil, 1, 1700000000000)
			if !jsonEqual(cliBatch["evidenceMeta"], cli["evidenceMeta"]) || !jsonEqual(cliBatch["evidence"], cli["evidence"]) {
				t.Fatal("CLI batch dropped scoped search metadata")
			}
			cliMeta := cli.object("evidenceMeta")
			if !jsonEqual(cliMeta["scope"], value(scope)) || cliMeta.number("count") != 60 {
				t.Fatalf("CLI lost scope/fallback/count: %s", value(cli))
			}
			cliCount := int64(60)
			if format == "tree" {
				cliCount = 20
			}
			if cliMeta.number("returnedCount") != cliCount || cliMeta.object("completeness").boolean("complete") != (format == "outline") {
				t.Fatalf("CLI misreported delivery completeness: %s", value(cliMeta))
			}
			single := mcpResponse(response, "dom.get_accessibility_tree", params).object("structuredContent")
			meta := single.object("evidenceMeta")
			if !jsonEqual(meta["scope"], value(scope)) || meta.number("count") != 60 || meta.object("search").number("matchCount") != 60 {
				t.Fatalf("MCP lost scope/search metadata: %s", value(single))
			}
			if format == "outline" {
				text := single.text("evidence")
				if len(text) > 4000 || !strings.HasSuffix(text, " [match]") || meta.object("completeness").boolean("complete") || meta.number("returnedCount") >= 60 {
					t.Fatalf("MCP cut a ref or claimed complete delivery: %s", value(single))
				}
				if meta.object("search").number("returnedMatches") != meta.number("returnedCount") {
					t.Fatal("MCP search counts describe omitted matches")
				}
			} else if !meta.object("completeness").boolean("complete") || meta.number("returnedCount") != 60 {
				t.Fatalf("MCP inherited CLI-only clipping: %s", value(meta))
			}
			c, _ := mcpTestDaemon(t, func(request object) object { return success(request.text("id"), snapshot) })
			s := &mcpSession{config: c, agentSession: "scoped-outline"}
			t.Cleanup(func() {
				for _, cl := range s.clients {
					cl.close()
				}
			})
			batch, err := s.batch(context.Background(), object{"calls": value([]object{{"method": value("dom.get_accessibility_tree"), "params": value(params), "tabId": value(4)}})}, "modern")
			if err != nil || batch.boolean("isError") {
				t.Fatalf("batch failed: %v %s", err, value(batch))
			}
			var items []object
			if err := json.Unmarshal(batch.object("structuredContent")["results"], &items); err != nil || len(items) != 1 {
				t.Fatalf("unexpected batch: %v %s", err, value(batch))
			}
			for _, key := range []string{"evidence", "evidenceMeta"} {
				if !jsonEqual(items[0][key], single[key]) {
					t.Fatalf("single/batch %s mismatch: %s", key, value(items[0]))
				}
			}
		})
	}
}

func TestScopedDOMOutlineExtractionLimitsSurviveFormatting(t *testing.T) {
	for _, text := range []string{"", strings.Repeat("x", 4100)} {
		result := object{
			"source": value("dom"), "format": value("outline"), "outline": value(text), "count": value(1), "scanned": value(20000), "truncated": value(true),
			"scope":        value(object{"requested": value("auto"), "resolved": value("document"), "boundary": value("document"), "scanned": value(20000), "fallbackReason": value("scope_scan_limit")}),
			"completeness": value(object{"complete": value(false), "reasons": value([]string{"scopeScanLimit", "scanLimit"})}),
			"search":       value(object{"query": value("Save"), "context": value(0), "matchCount": value(0), "returnedMatches": value(0)}),
		}
		single := mcpResponse(success("limited", result), "dom.get_accessibility_tree", object{}).object("structuredContent")
		completeness := single.object("evidenceMeta").object("completeness")
		var reasons []string
		_ = json.Unmarshal(completeness["reasons"], &reasons)
		if completeness.boolean("complete") || !stringIn("scopeScanLimit", reasons) || !stringIn("scanLimit", reasons) {
			t.Fatalf("formatting lost extraction incompleteness: %s", value(single))
		}
		if text != "" && single.text("evidence") != "" {
			t.Fatal("overlong single line must be omitted rather than cutting a ref")
		}
	}
}

func TestDOMOutlineTypedToolForwardsScopeSearch(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object {
		return success(request.text("id"), object{"source": value("dom"), "format": value("outline"), "outline": value(""), "count": value(0)})
	})
	s := &mcpSession{config: c, agentSession: "typed-outline"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	_, err := s.handleTool(context.Background(), "browser_dom", object{"action": value("accessibility_tree"), "source": value("dom"), "scope": value("auto"), "find": value("literal.*"), "context": value(0), "tabId": value(4)}, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	params := (<-requests).object("params")
	if params.text("scope") != "auto" || params.text("find") != "literal.*" || params.number("context") != 0 {
		t.Fatalf("typed tool dropped scope/search: %s", value(params))
	}
}
