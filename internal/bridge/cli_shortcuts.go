package bridge

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

func atomicTarget(s string) (object, error) {
	if s == "" {
		return nil, errors.New("A ref or selector is required.")
	}
	if strings.HasPrefix(s, "el_") {
		return object{"elementRef": value(s)}, nil
	}
	return object{"selector": value(s)}, nil
}
func cliNumber(s, name string, positiveInteger bool) (float64, error) {
	trimmed := strings.TrimSpace(s)
	n, err := strconv.ParseFloat(trimmed, 64)
	if trimmed == "" && s != "" {
		n, err = 0, nil
	}
	if len(trimmed) > 2 && trimmed[0] == '0' {
		base := 0
		switch trimmed[1] {
		case 'x', 'X':
			base = 16
		case 'b', 'B':
			base = 2
		case 'o', 'O':
			base = 8
		}
		if base != 0 {
			integer, e := strconv.ParseUint(trimmed[2:], base, 64)
			n, err = float64(integer), e
		}
	}
	if err != nil || math.IsInf(n, 0) || math.IsNaN(n) || (positiveInteger && (n <= 0 || math.Trunc(n) != n)) {
		return 0, fmt.Errorf("%s must be %s (got %s).", name, map[bool]string{true: "a positive integer", false: "a number"}[positiveInteger], cliQuote(s))
	}
	return n, nil
}
func buildShortcut(command string, args []string) (string, object, error) {
	definition := cliCommandByName(command)
	if definition == nil || definition.method == "" {
		return "", nil, nil
	}
	a := &cliShortcutArgs{definition: definition, args: args, params: object{}}
	if definition.target {
		target, err := atomicTarget(a.arg(0))
		if err != nil {
			return "", nil, err
		}
		a.params["target"] = value(target)
	}
	if definition.parse != nil {
		definition.parse(a)
	}
	return definition.method, a.params, a.err
}

type cliShortcutArgs struct {
	definition *cliCommandDefinition
	args       []string
	params     object
	err        error
}

func (a *cliShortcutArgs) arg(index int) string {
	if index < len(a.args) {
		return a.args[index]
	}
	return ""
}
func (a *cliShortcutArgs) put(key string, index int) {
	if text := a.arg(index); text != "" {
		a.params[key] = value(text)
	}
}
func (a *cliShortcutArgs) require(index int) {
	if a.err == nil && a.arg(index) == "" {
		a.err = fmt.Errorf("Usage: %s", a.definition.usage)
	}
}
func (a *cliShortcutArgs) number(key, label string, index int, positive bool) {
	if a.err != nil || a.arg(index) == "" {
		return
	}
	n, err := cliNumber(a.arg(index), label, positive)
	if err != nil {
		a.err = err
	} else {
		a.params[key] = value(n)
	}
}
func parseAccessShortcut(a *cliShortcutArgs) {
	if len(a.args) > 1 {
		a.err = fmt.Errorf("Usage: %s", a.definition.usage)
		return
	}
	a.put("intent", 0)
}
func shortcutList(field string) func(*cliShortcutArgs) {
	return func(a *cliShortcutArgs) {
		list := []string{}
		for _, item := range strings.Split(a.arg(1), ",") {
			if item = strings.TrimSpace(item); item != "" {
				list = append(list, item)
			}
		}
		a.params[field] = value(list)
	}
}
func shortcutText(field string, extras object) func(*cliShortcutArgs) {
	return func(a *cliShortcutArgs) {
		text := ""
		if len(a.args) > 1 {
			text = strings.Join(a.args[1:], " ")
		}
		a.params[field] = value(text)
		for key, val := range extras {
			a.params[key] = val
		}
	}
}
func parseStyleShortcut(a *cliShortcutArgs) {
	declarations := map[string]string{}
	for _, item := range a.args[1:] {
		key, val, ok := strings.Cut(item, "=")
		if ok && strings.TrimSpace(key) != "" {
			declarations[strings.TrimSpace(key)] = strings.TrimSpace(val)
		}
	}
	a.params["declarations"] = value(declarations)
}
func parseStorageShortcut(a *cliShortcutArgs) {
	a.params["type"] = value("local")
	if a.arg(0) == "session" {
		a.params["type"] = value("session")
	}
	if len(a.args) > 1 {
		a.params["keys"] = value(a.args[1:])
	}
}
func parseKeyShortcut(a *cliShortcutArgs) {
	a.require(0)
	a.put("key", 0)
	if a.arg(1) != "" {
		target, err := atomicTarget(a.arg(1))
		if err != nil {
			a.err = err
		} else {
			a.params["target"] = value(target)
		}
	}
}

func parseIntercept(args []string) (string, object, error) {
	usage := errors.New("usage: bbx intercept <add|remove|list|clear> [args]")
	if len(args) == 0 {
		return "", nil, usage
	}
	p := object{}
	method := "network.intercept." + args[0]
	switch args[0] {
	case "list", "clear":
		if len(args) != 1 {
			return "", nil, usage
		}
	case "remove":
		if len(args) != 2 || args[1] == "" {
			return "", nil, usage
		}
		p["ruleId"] = value(args[1])
	case "add":
		if len(args) < 2 || strings.HasPrefix(args[1], "--") {
			return "", nil, usage
		}
		p["urlPattern"] = value(args[1])
		p["action"] = value("continue")
		p["statusCode"] = value(200)
		seen := map[string]bool{}
		for i := 2; i < len(args); i++ {
			flag := args[i]
			if seen[flag] {
				return "", nil, fmt.Errorf("duplicate option %s", flag)
			}
			seen[flag] = true
			if flag == "--block" {
				p["action"] = value("block")
				continue
			}
			if flag != "--respond" && flag != "--status" {
				return "", nil, fmt.Errorf("unknown intercept option %s", flag)
			}
			i++
			if i >= len(args) || strings.HasPrefix(args[i], "--") {
				return "", nil, fmt.Errorf("%s requires a value", flag)
			}
			if flag == "--respond" {
				p["body"] = value(args[i])
				p["action"] = value("fulfill")
			} else {
				n, e := cliNumber(args[i], "status", true)
				if e != nil || n < 100 || n > 599 {
					return "", nil, errors.New("status must be an integer between 100 and 599")
				}
				p["statusCode"] = value(n)
			}
		}
		if seen["--block"] && seen["--respond"] {
			return "", nil, errors.New("use either --block or --respond, not both")
		}
	default:
		return "", nil, usage
	}
	return method, p, nil
}
