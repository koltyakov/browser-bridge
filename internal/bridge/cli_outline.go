package bridge

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Extraction and delivery completeness are distinct. Compact CLI/MCP formatting
// must not turn a clipped result into an apparently complete scoped search.
func cliOutlineEvidenceMeta(result object, evidence json.RawMessage) object {
	if cliOutlineIsComparison(result) {
		return nil
	}
	if result.text("source") != "dom" || result["scope"] == nil || result["completeness"] == nil {
		return cliOutlineSnapshotMeta(result, nil)
	}
	returned, matches := 0, 0
	var nodes []object
	var text string
	limited := false
	if json.Unmarshal(evidence, &nodes) == nil {
		returned = len(nodes)
		for _, node := range nodes {
			if node.boolean("matched") {
				matches++
			}
		}
	} else if json.Unmarshal(evidence, &text) == nil {
		if text != "" {
			lines := strings.Split(text, "\n")
			returned = len(lines)
			for _, line := range lines {
				if strings.HasSuffix(line, " [match]") {
					matches++
				}
			}
		}
		limited = text != result.text("outline")
	}
	limited = limited || int64(returned) < result.number("count")
	meta := mcpPick(result, "source format count scanned scope")
	meta["returnedCount"], meta["truncated"] = value(returned), value(result.boolean("truncated") || limited)
	completeness := mcpClone(result.object("completeness"))
	if limited {
		var reasons []string
		_ = json.Unmarshal(completeness["reasons"], &reasons)
		if !stringIn("deliveryLimit", reasons) {
			reasons = append(reasons, "deliveryLimit")
		}
		completeness["complete"], completeness["reasons"] = value(false), value(reasons)
	}
	meta["completeness"] = value(completeness)
	if search := result.object("search"); search != nil {
		search = mcpClone(search)
		search["returnedMatches"] = value(matches)
		meta["search"] = value(search)
	}
	return cliOutlineSnapshotMeta(result, meta)
}

// cliOutlineIsComparison reports a DOM outline read with since that returned
// unchanged or a delta instead of the outline.
func cliOutlineIsComparison(result object) bool {
	return result.text("source") == "dom" && (result.boolean("unchanged") || result.object("delta") != nil)
}

// cliOutlineSnapshotMeta adds the snapshot an agent passes as since on its next
// read, and why a read with since returned the full outline. A summary that
// dropped them would force a full read every time.
func cliOutlineSnapshotMeta(result, meta object) object {
	if result.text("source") != "dom" || result.text("snapshotId") == "" {
		return meta
	}
	if meta == nil {
		meta = object{}
	}
	for key, field := range mcpPick(result, "snapshotId deltaUnavailable") {
		meta[key] = field
	}
	return meta
}

// cliOutlineComparisonSummary shapes an unchanged or delta outline result.
// The delta is the evidence; counts and the next snapshotId go beside it.
func cliOutlineComparisonSummary(result object) (string, json.RawMessage, object) {
	meta := mcpPick(result, "source format count scanned truncated frames incompleteFrames scope search completeness snapshotId")
	if result.boolean("unchanged") {
		return fmt.Sprintf("Accessibility outline unchanged: %d node(s); refs from the base still apply.", result.number("count")), value(object{"unchanged": value(true)}), meta
	}
	delta := result.object("delta")
	length := func(key string) int {
		items, _ := cliArray(delta[key])
		return len(items)
	}
	summary := fmt.Sprintf("Accessibility outline delta: %d added, %d changed, %d removed of %d node(s).", length("added"), length("changed"), length("removed"), result.number("count"))
	if frames := length("removedFrames"); frames > 0 {
		summary += fmt.Sprintf(" Drop earlier lines of %d frame(s) in removedFrames.", frames)
	}
	return summary, result["delta"], meta
}
