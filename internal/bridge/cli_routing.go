package bridge

import (
	"fmt"
	"slices"
	"strings"
)

// cliValueFlags are routing and budget flags that take one value. parseCLI
// accepts them anywhere, so a leading flag only needs to move after the
// command for command lookup.
var cliValueFlags = []string{"--tab", "--extension", "--browser", "--profile", "--preset"}

// hoistLeadingRoutingFlags turns `bbx --tab 7 call m` into `bbx call --tab 7 m`,
// matching where --remote is accepted.
func hoistLeadingRoutingFlags(args []string) []string {
	leading := []string{}
	i := 0
	for i < len(args) {
		if slices.Contains(cliValueFlags, args[i]) && i+1 < len(args) {
			leading = append(leading, args[i], args[i+1])
			i += 2
			continue
		}
		if args[i] == "--evidence-only" {
			leading = append(leading, args[i])
			i++
			continue
		}
		break
	}
	if len(leading) == 0 || i >= len(args) {
		return args
	}
	out := append([]string{args[i]}, leading...)
	return append(out, args[i+1:]...)
}

// foldCLIRoutingParams moves routing keys written inside params, such as
// {"tabId": 7}, to the request routing the CLI flags set. A key that conflicts
// with an explicit flag, or a destination that is chosen before the request is
// built, stays an error.
func foldCLIRoutingParams(request object) (object, error) {
	method, params, meta := request.text("method"), request.object("params"), request.object("meta")
	key := misplacedRoutingParam(method, params)
	if key == "" {
		return request, nil
	}
	if meta == nil {
		meta = object{}
	}
	metaKeys := map[string]string{"extensionId": "target_extension", "targetBrowser": "target_browser", "targetProfile": "target_profile"}
	for key != "" {
		raw := params[key]
		switch {
		case key == "tabId":
			if current := string(request["tab_id"]); current != "" && current != "null" && current != string(raw) {
				return nil, fmt.Errorf("tabId inside params conflicts with --tab for %s.", method)
			}
			if !catalog.Methods[method].boolean("tab") {
				return nil, fmt.Errorf("%s does not target a tab; remove tabId from params.", method)
			}
			request["tab_id"] = raw
		case metaKeys[key] != "":
			if current := meta[metaKeys[key]]; current != nil && string(current) != string(raw) {
				return nil, fmt.Errorf("%s inside params conflicts with %s for %s.", key, cliRoutingFlags[key], method)
			}
			meta[metaKeys[key]] = raw
		default:
			return nil, fmt.Errorf("%s inside params is ignored by %s. Use %s instead.", key, method, cliRoutingFlags[key])
		}
		delete(params, key)
		key = misplacedRoutingParam(method, params)
	}
	request["params"], request["meta"] = value(params), value(meta)
	return request, nil
}

// unknownCommandMessage replaces the full usage dump with the closest command
// or method and the generic call path.
func unknownCommandMessage(command string) string {
	message := "Unknown command: " + command + "."
	if strings.HasPrefix(command, "-") {
		return message + " Put flags after the command, for example `bbx call --tab <id> <method> '{...}'`; run `bbx help` for commands."
	}
	best, distance := "", 3
	for name := range shortcutMethods {
		if d := editDistance(command, name); d < distance {
			best, distance = name, d
		}
	}
	if best != "" {
		return message + " Did you mean `bbx " + best + "`? Run `bbx help` for commands."
	}
	if strings.Contains(command, ".") || strings.Contains(command, "_") {
		if suggestion := suggestMethod(command); suggestion != "" {
			return message + " Did you mean `bbx call " + suggestion + "`?"
		}
	}
	return message + " Run `bbx help` for commands, or `bbx call <method> '{...}'` for any bridge method."
}
