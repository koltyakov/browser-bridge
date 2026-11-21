package bridge

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// paramRoutingKeys select the machine, profile, or tab for a call. Nested in
// params they are ignored, so the call would silently run somewhere else.
var paramRoutingKeys = []string{"tabId", "extensionId", "targetBrowser", "targetProfile", "destinationId"}

// cliRoutingFlags names the CLI flag that carries each routing key.
var cliRoutingFlags = map[string]string{"tabId": "--tab", "extensionId": "--extension", "targetBrowser": "--browser", "targetProfile": "--profile", "destinationId": "--remote"}

// paramSynonyms maps names common in other automation APIs to the bridge
// params they usually mean. A synonym is suggested only when the method
// declares it.
var paramSynonyms = func() map[string][]string {
	groups := [][2][]string{
		// Bridge methods name their size bound differently, so each name also
		// suggests the others.
		{{"limit", "max", "count", "maxcount", "maxitems", "top", "maxresults", "maxnodes", "maxentries"}, {"maxResults", "maxNodes", "maxEntries", "limit"}},
		{{"attributes", "attrs", "attributelist"}, {"attributeAllowlist", "attributes"}},
		{{"y", "scrolly", "deltay"}, {"top"}},
		{{"x", "scrollx", "deltax"}, {"left"}},
		{{"ref", "element", "elementid"}, {"elementRef", "target"}},
		{{"timeout"}, {"timeoutMs"}},
		{{"maxchars", "maxlength", "charbudget", "tokenbudget", "textlimit"}, {"textBudget", "maxLength"}},
		{{"props", "styles"}, {"properties"}},
		{{"script", "code", "js"}, {"expression"}},
		{{"css", "query"}, {"selector"}},
	}
	synonyms := map[string][]string{}
	for _, group := range groups {
		for _, name := range group[0] {
			synonyms[name] = group[1]
		}
	}
	return synonyms
}()

// declaredParams lists the params the catalog documents for method, plus the
// keys budget presets inject.
func declaredParams(method string) map[string]bool {
	declared := map[string]bool{}
	var names []string
	_ = json.Unmarshal(catalog.Methods[method]["params"], &names)
	for _, name := range names {
		declared[name] = true
	}
	for _, preset := range catalog.Presets {
		for name := range preset[method] {
			declared[name] = true
		}
	}
	return declared
}

// misplacedRoutingParam returns a routing key nested in params that method
// does not declare as its own param.
func misplacedRoutingParam(method string, params object) string {
	declared := declaredParams(method)
	for _, key := range paramRoutingKeys {
		if _, ok := params[key]; ok && !declared[key] {
			return key
		}
	}
	return ""
}

// paramWarnings reports undeclared params that closely match a declared one,
// including input.perform step params. Catalog param lists cover the
// documented surface, not every alias the extension tolerates, so keys
// without a near match are left alone.
func paramWarnings(method string, params object) []string {
	declared := declaredParams(method)
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	warnings := []string{}
	for _, key := range keys {
		if declared[key] || strings.HasPrefix(key, "_") {
			continue
		}
		if suggestion := suggestParam(key, declared); suggestion != "" {
			warnings = append(warnings, fmt.Sprintf("%s is not a %s param; did you mean %s?", key, method, suggestion))
		}
	}
	if method == "input.perform" {
		var steps []object
		if json.Unmarshal(params["steps"], &steps) == nil {
			for i, step := range steps {
				for _, warning := range paramWarnings(step.text("method"), step.object("params")) {
					warnings = append(warnings, fmt.Sprintf("steps[%d]: %s", i, warning))
				}
			}
		}
	}
	return warnings
}

// suggestParam prefers a case-insensitive match, then a known synonym, then a
// shared prefix, then a near spelling.
func suggestParam(key string, declared map[string]bool) string {
	names := make([]string, 0, len(declared))
	for name := range declared {
		names = append(names, name)
	}
	sort.Strings(names)
	folded := strings.ToLower(key)
	for _, name := range names {
		if strings.ToLower(name) == folded {
			return name
		}
	}
	for _, candidate := range paramSynonyms[folded] {
		if declared[candidate] {
			return candidate
		}
	}
	if len(folded) < 5 {
		return ""
	}
	for _, name := range names {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, folded) || (len(lower) >= 5 && strings.HasPrefix(folded, lower)) {
			return name
		}
	}
	best, bestDistance := "", 3
	for _, name := range names {
		if distance := editDistance(folded, strings.ToLower(name)); distance < bestDistance {
			best, bestDistance = name, distance
		}
	}
	return best
}

func editDistance(a, b string) int {
	previous := make([]int, len(b)+1)
	for j := range previous {
		previous[j] = j
	}
	for i := 1; i <= len(a); i++ {
		current := make([]int, len(b)+1)
		current[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			current[j] = min(previous[j]+1, current[j-1]+1, previous[j-1]+cost)
		}
		previous = current
	}
	return previous[len(b)]
}

// methodAliases maps method names agents borrow from other automation APIs to
// the bridge method with the same effect.
var methodAliases = map[string]string{
	"goto": "navigation.navigate", "open": "navigation.navigate", "visit": "navigation.navigate",
	"reload": "navigation.reload", "refresh": "navigation.reload", "back": "navigation.go_back",
	"forward": "navigation.go_forward", "screenshot": "screenshot.capture_region",
	"evaluate": "page.evaluate", "eval": "page.evaluate", "title": "page.get_state",
	"url": "page.get_state", "content": "page.get_text", "html": "dom.get_html",
	"find": "dom.find_by_text", "locate": "dom.find_by_text", "select": "input.select_option",
	"check": "input.set_checked", "uncheck": "input.set_checked", "wait": "dom.wait_for", "text": "page.get_text",
}

// unknownMethodMessage names the closest catalog method, so a guessed name
// such as page.navigate costs one correction instead of a discovery round.
func unknownMethodMessage(method string) string {
	message := "Unknown bridge method: " + method
	if suggestion := suggestMethod(method); suggestion != "" {
		message += ". Did you mean " + suggestion + "?"
	} else {
		message += ". Find methods with protocol.describe {query}."
	}
	return message
}

// suggestMethod prefers a catalog method with the same action name, then a
// known alias, then a near spelling.
func suggestMethod(method string) string {
	folded := strings.ToLower(strings.TrimSpace(method))
	if folded == "" {
		return ""
	}
	names := make([]string, 0, len(catalog.Methods))
	for name := range catalog.Methods {
		names = append(names, name)
	}
	sort.Strings(names)
	action := folded[strings.LastIndex(folded, ".")+1:]
	group := ""
	if dot := strings.Index(folded, "."); dot > 0 {
		group = folded[:dot]
	}
	var sameAction []string
	for _, name := range names {
		if strings.ToLower(name) == folded {
			return name
		}
		if name[strings.LastIndex(name, ".")+1:] == action {
			sameAction = append(sameAction, name)
		}
	}
	if len(sameAction) == 1 {
		return sameAction[0]
	}
	for _, name := range sameAction {
		if strings.HasPrefix(name, group+".") {
			return name
		}
	}
	if alias := methodAliases[action]; alias != "" {
		return alias
	}
	if len(sameAction) > 0 {
		return sameAction[0]
	}
	best, bestDistance := "", 4
	for _, name := range names {
		if distance := editDistance(folded, name); distance < bestDistance {
			best, bestDistance = name, distance
		}
	}
	return best
}
