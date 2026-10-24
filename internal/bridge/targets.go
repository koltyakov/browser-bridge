package bridge

// Selector lookup only needs the first element's ref. Keep dom.query's frame
// routing without collecting the subtree, attributes, or layout geometry.
func elementRefQueryParams(selector string) object {
	return object{
		"selector":           value(selector),
		"maxNodes":           value(1),
		"maxDepth":           value(1),
		"textBudget":         value(32),
		"includeBbox":        value(false),
		"attributeAllowlist": value([]string{}),
	}
}
