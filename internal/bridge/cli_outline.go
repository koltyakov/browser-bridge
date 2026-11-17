package bridge

import (
	"encoding/json"
	"strings"
)

// Extraction and delivery completeness are distinct. Compact CLI/MCP formatting
// must not turn a clipped result into an apparently complete scoped search.
func cliOutlineEvidenceMeta(result object, evidence json.RawMessage) object {
	if result.text("source") != "dom" || result["scope"] == nil || result["completeness"] == nil {
		return nil
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
	return meta
}
