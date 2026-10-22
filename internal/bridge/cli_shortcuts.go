package bridge

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

var shortcutMethods = map[string]string{
	"status": "health.ping", "tabs": "tabs.list", "logs": "log.tail",
	"access-request": "access.request", "dom-query": "dom.query", "describe": "dom.describe", "text": "dom.get_text", "styles": "styles.get_computed", "box": "layout.get_box_model", "click": "input.click", "focus": "input.focus", "type": "input.type", "fill": "input.fill", "hover": "input.hover", "html": "dom.get_html", "patch-style": "patch.apply_styles", "patch-text": "patch.apply_dom", "patches": "patch.list", "rollback": "patch.rollback", "console": "page.get_console", "wait": "dom.wait_for", "find": "dom.find_by_text", "find-role": "dom.find_by_role", "navigate": "navigation.navigate", "storage": "page.get_storage", "page-text": "page.get_text", "network": "page.get_network", "a11y-tree": "dom.get_accessibility_tree", "perf": "performance.get_metrics", "scroll": "viewport.scroll", "resize": "viewport.resize", "reload": "navigation.reload", "back": "navigation.go_back", "forward": "navigation.go_forward", "attrs": "dom.get_attributes", "matched-rules": "styles.get_matched_rules", "tab-create": "tabs.create", "tab-close": "tabs.close", "tab-activate": "tabs.activate", "press-key": "input.press_key", "cdp-press-key": "cdp.dispatch_key_event",
}

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
	method, ok := shortcutMethods[command]
	if !ok {
		return "", nil, nil
	}
	p := object{}
	arg := func(i int) string {
		if i < len(args) {
			return args[i]
		}
		return ""
	}
	put := func(key string, i int) {
		if arg(i) != "" {
			p[key] = value(arg(i))
		}
	}
	number := func(key string, i int, positive bool) error {
		if arg(i) == "" {
			return nil
		}
		label := key
		if command == "text" && key == "textBudget" {
			label = "budget"
		}
		if command == "html" && key == "maxLength" {
			label = "maxLen"
		}
		n, e := cliNumber(arg(i), label, positive)
		if e == nil {
			p[key] = value(n)
		}
		return e
	}
	require := func(i int) error {
		if arg(i) == "" {
			usage := map[string]string{"rollback": "rollback <patchId>", "wait": "wait <selector> [timeoutMs]", "find-role": "find-role <role> [name]", "navigate": "navigate <url>", "scroll": "scroll <top> [left]", "resize": "resize <width> <height>", "tab-close": "tab-close <tabId>", "tab-activate": "tab-activate <tabId>", "press-key": "press-key <key> [ref|selector]", "cdp-press-key": "cdp-press-key [--tab <tabId>] <key> [code]"}
			return fmt.Errorf("Usage: %s", usage[command])
		}
		return nil
	}
	targetCommands := " describe text styles box click focus type fill hover html patch-style patch-text attrs matched-rules "
	if strings.Contains(targetCommands, " "+command+" ") {
		t, e := atomicTarget(arg(0))
		if e != nil {
			return "", nil, e
		}
		p["target"] = value(t)
	}
	var err error
	switch command {
	case "access-request":
		if len(args) > 1 {
			return "", nil, errors.New("Usage: bbx access-request [intent]")
		}
		put("intent", 0)
	case "dom-query":
		p["selector"] = value("body")
		put("selector", 0)
	case "text":
		err = number("textBudget", 1, true)
	case "html":
		err = number("maxLength", 1, true)
	case "styles", "attrs":
		list := []string{}
		for _, s := range strings.Split(arg(1), ",") {
			if s = strings.TrimSpace(s); s != "" {
				list = append(list, s)
			}
		}
		key := "properties"
		if command == "attrs" {
			key = "attributes"
		}
		p[key] = value(list)
	case "click":
		put("button", 1)
	case "type", "fill", "patch-text":
		text := ""
		if len(args) > 1 {
			text = strings.Join(args[1:], " ")
		}
		key := "text"
		if command != "type" {
			key = "value"
		}
		p[key] = value(text)
		if command == "fill" {
			p["mode"] = value("auto")
		}
		if command == "patch-text" {
			p["operation"] = value("set_text")
		}
	case "patch-style":
		declarations := map[string]string{}
		for _, s := range args[1:] {
			k, v, ok := strings.Cut(s, "=")
			if ok && strings.TrimSpace(k) != "" {
				declarations[strings.TrimSpace(k)] = strings.TrimSpace(v)
			}
		}
		p["declarations"] = value(declarations)
	case "rollback":
		err = require(0)
		put("patchId", 0)
	case "console":
		p["level"] = value("all")
		p["clear"] = value(false)
		put("level", 0)
	case "wait":
		err = require(0)
		put("selector", 0)
		p["timeoutMs"] = value(5000)
		if err == nil {
			err = number("timeoutMs", 1, true)
		}
	case "find":
		text := strings.Join(args, " ")
		if text == "" {
			err = errors.New("Usage: find <text>")
		} else {
			p["text"] = value(text)
		}
	case "find-role":
		err = require(0)
		put("role", 0)
		if len(args) > 1 && strings.Join(args[1:], " ") != "" {
			p["name"] = value(strings.Join(args[1:], " "))
		}
	case "navigate":
		err = require(0)
		put("url", 0)
	case "storage":
		p["type"] = value("local")
		if arg(0) == "session" {
			p["type"] = value("session")
		}
		if len(args) > 1 {
			p["keys"] = value(args[1:])
		}
	case "page-text":
		err = number("textBudget", 0, true)
	case "network":
		err = number("limit", 0, true)
	case "a11y-tree":
		err = number("maxNodes", 0, true)
		if err == nil {
			err = number("maxDepth", 1, true)
		}
	case "scroll":
		err = require(0)
		if err == nil {
			err = number("top", 0, false)
		}
		if err == nil {
			err = number("left", 1, false)
		}
	case "resize":
		err = require(1)
		if err == nil {
			err = number("width", 0, true)
		}
		if err == nil {
			err = number("height", 1, true)
		}
	case "tab-create":
		put("url", 0)
	case "tab-close", "tab-activate":
		err = require(0)
		if err == nil {
			err = number("tabId", 0, true)
		}
	case "press-key":
		err = require(0)
		put("key", 0)
		if arg(1) != "" {
			t, e := atomicTarget(arg(1))
			if e != nil {
				return "", nil, e
			}
			p["target"] = value(t)
		}
	case "cdp-press-key":
		err = require(0)
		put("key", 0)
		put("code", 1)
	}
	return method, p, err
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
