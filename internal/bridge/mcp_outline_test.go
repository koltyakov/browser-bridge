package bridge

import (
	"context"
	"encoding/json"
	"fmt"
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
