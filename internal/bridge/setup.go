package bridge

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func installAgentDetected(target string, scope installScope) bool {
	if agent := installAgentByKey(target); agent != nil {
		return installPresenceDetected(agent, scope)
	}
	return false
}

func installDetectedOverride(env, target string, fallback bool) bool {
	if raw, present := os.LookupEnv(env); present {
		for _, part := range strings.Split(strings.ToLower(raw), ",") {
			if strings.TrimSpace(part) == target {
				return true
			}
		}
		return false
	}
	return fallback
}

func installVersionOutdated(installed, current string) bool {
	if current == "" {
		return false
	}
	if installed == "" {
		return true
	}
	parse := func(v string) ([3]int, string) {
		v = strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(v), "v"), "V")
		parts := strings.SplitN(v, "-", 2)
		core := strings.Split(parts[0], ".")
		result := [3]int{}
		for i := 0; i < 3 && i < len(core); i++ {
			digits := strings.TrimRightFunc(core[i], func(r rune) bool { return r < '0' || r > '9' })
			result[i], _ = strconv.Atoi(digits)
		}
		pre := ""
		if len(parts) == 2 {
			pre = parts[1]
		}
		return result, pre
	}
	a, ap := parse(installed)
	b, bp := parse(current)
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	if ap == bp {
		return false
	}
	if ap == "" {
		return false
	}
	if bp == "" {
		return true
	}
	return ap < bp
}

func setupStatus(c config) (object, error) {
	scope, err := installCurrentScope()
	if err != nil {
		return nil, err
	}
	return installCollectStatus(scope), nil
}

func installCollectStatus(scope installScope) object {
	mcpClients, skillTargets := []object{}, []object{}
	for _, target := range installAgentNames {
		detected := installAgentDetected(target, scope)
		mcpDetected := installDetectedOverride("BBX_TEST_DETECTED_MCP_CLIENTS", target, detected)
		skillDetected := target == "agents" || mcpDetected || installDetectedOverride("BBX_TEST_DETECTED_SKILL_TARGETS", target, detected)
		paths := installMCPPaths(target, scope)
		preferred := ""
		if len(paths) > 0 {
			preferred = paths[0]
		}
		exists, configured, stale := false, false, false
		for _, path := range paths {
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			if !exists {
				preferred = path
			}
			exists = true
			if installMCPConfigured(string(data), target, path, scope) {
				if !configured {
					preferred = path
					stale = installMCPStale(string(data), target, path, scope)
				}
				configured = true
			}
		}
		mcpClients = append(mcpClients, object{"key": value(target), "label": value(installAgentLabels[target]), "detected": value(mcpDetected), "configPath": value(preferred), "configExists": value(exists), "configured": value(configured), "stale": value(stale)})
		base := installSkillBase(target, scope)
		path := filepath.Join(base, "browser-bridge")
		metadata, managed, _ := installReadSkillMetadata(path)
		installed := installExists(path)
		if installSharedSkillTarget(target, scope) && !detected && !installContains(metadata.Targets, target) {
			// A generic shared bundle is not proof that this editor/agent exists.
			installed = false
		}
		managed = managed && installed
		var installedVersion *string
		if managed && metadata.Version != "" {
			installedVersion = &metadata.Version
		}
		skill := object{"name": value("browser-bridge"), "path": value(path), "exists": value(installed), "managed": value(managed), "version": value(installedVersion)}
		skillTargets = append(skillTargets, object{"key": value(target), "label": value(installAgentLabels[target]), "detected": value(skillDetected), "basePath": value(base), "installed": value(installed), "managed": value(managed), "installedVersion": value(installedVersion), "currentVersion": value(version), "updateAvailable": value(managed && installVersionOutdated(metadata.Version, version)), "skills": value([]object{skill})})
	}
	scopeName := "global"
	if !scope.global {
		scopeName = "local"
	}
	return object{"scope": value(scopeName), "mcpClients": value(mcpClients), "skillTargets": value(skillTargets)}
}

func setupInstall(c config, params object) (object, error) {
	action := params.text("action")
	if _, present := params["action"]; !present || string(params["action"]) == "null" {
		action = "install"
	}
	if action != "install" && action != "uninstall" {
		return nil, errors.New(`setup.install action must be "install" or "uninstall"`)
	}
	kind := params.text("kind")
	target := strings.ToLower(strings.TrimSpace(params.text("target")))
	if kind != "mcp" && kind != "skill" {
		return nil, errors.New(`setup.install requires kind to be "mcp" or "skill"`)
	}
	if !installContains(installAgentNames, target) {
		return nil, fmt.Errorf("unsupported %s target %q", kind, target)
	}
	scope, err := installCurrentScope()
	if err != nil {
		return nil, err
	}
	var paths []string
	if kind == "mcp" {
		paths, err = installAgentMCP(target, scope, action == "uninstall")
	} else {
		paths, err = installAgentSkill(target, scope, action == "uninstall")
	}
	if err != nil {
		return nil, err
	}
	// The protocol reports the primary MCP path for an install, although Copilot
	// also receives the entry in each existing VS Code profile.
	if kind == "mcp" && action == "install" && len(paths) > 1 {
		paths = paths[:1]
	}
	return object{"action": value(action), "kind": value(kind), "target": value(target), "paths": value(paths)}, nil
}

func installSelectsAll(raw string) bool {
	for _, part := range strings.Split(strings.ToLower(raw), ",") {
		if strings.TrimSpace(part) == "all" {
			return true
		}
	}
	return false
}

func installParseTargets(raw string, aliases bool) ([]string, error) {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(raw)), ",")
	if installSelectsAll(raw) {
		return append([]string{}, installAgentNames...), nil
	}
	result := []string{}
	for _, part := range parts {
		target := strings.TrimSpace(part)
		if target == "" {
			continue
		}
		if aliases {
			for _, agent := range installAgentRegistry {
				if installContains(agent.aliases, target) {
					target = agent.key
					break
				}
			}
		}
		if !installContains(installAgentNames, target) {
			return nil, fmt.Errorf("unknown target %q; supported: %s, all", target, strings.Join(installAgentNames, ", "))
		}
		if !installContains(result, target) {
			result = append(result, target)
		}
	}
	if len(result) == 0 {
		return nil, errors.New("target list cannot be empty")
	}
	return result, nil
}

func installParseAgentArgs(args []string, skill bool) (installScope, []string, error) {
	scope, err := installCurrentScope()
	if err != nil {
		return scope, nil, err
	}
	var targets []string
	allTargets := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		key, inline, hasInline := strings.Cut(arg, "=")
		next := func() (string, error) {
			if hasInline {
				if inline == "" {
					return "", fmt.Errorf("%s requires a value", key)
				}
				return inline, nil
			}
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
				return "", fmt.Errorf("%s requires a value", key)
			}
			i++
			return args[i], nil
		}
		switch key {
		case "--global":
			if hasInline {
				return scope, nil, fmt.Errorf("unknown option %s", arg)
			}
			scope.global = true
		case "--local":
			if hasInline {
				return scope, nil, fmt.Errorf("unknown option %s", arg)
			}
			scope.global = false
		case "--project":
			path, err := next()
			if err != nil {
				return scope, nil, err
			}
			if !filepath.IsAbs(path) {
				path = filepath.Join(scope.project, path)
			}
			scope.project = filepath.Clean(path)
			scope.global = false
		case "--agents", "--agent":
			if !skill {
				return scope, nil, fmt.Errorf("unknown install-mcp option %s", key)
			}
			raw, err := next()
			if err != nil {
				return scope, nil, err
			}
			targets, err = installParseTargets(raw, true)
			if err != nil {
				return scope, nil, err
			}
			allTargets = installSelectsAll(raw)
		default:
			if strings.HasPrefix(arg, "-") {
				return scope, nil, fmt.Errorf("unknown setup option %s", arg)
			}
			if targets != nil {
				return scope, nil, fmt.Errorf("unexpected extra argument %q", arg)
			}
			targets, err = installParseTargets(arg, skill)
			if err != nil {
				return scope, nil, err
			}
			allTargets = installSelectsAll(arg)
		}
	}
	if !skill && targets != nil {
		selected := []string{}
		for _, target := range targets {
			if allTargets && !installMCPSupported(target, scope) {
				continue
			}
			if err := installValidateMCPScope(target, scope); err != nil {
				return scope, nil, err
			}
			selected = append(selected, target)
		}
		targets = selected
	}
	return scope, targets, nil
}

func installDefaultTargets(scope installScope, skill bool) ([]string, []string) {
	installed, detected := []string{}, []string{}
	for _, target := range installAgentNames {
		if !skill && !installMCPSupported(target, scope) {
			continue
		}
		found := false
		if skill {
			metadata, managed, _ := installReadSkillMetadata(filepath.Join(installSkillBase(target, scope), "browser-bridge"))
			found = managed && installContains(installSkillOwners(metadata, target, scope), target)
		} else {
			for _, path := range installMCPPaths(target, scope) {
				if raw, err := os.ReadFile(path); err == nil && installMCPConfigured(string(raw), target, path, scope) {
					found = true
					break
				}
			}
		}
		if found {
			installed = append(installed, target)
		}
		isDetected := installAgentDetected(target, scope)
		mcpDetected := installDetectedOverride("BBX_TEST_DETECTED_MCP_CLIENTS", target, isDetected)
		if skill {
			isDetected = target == "agents" || mcpDetected || installDetectedOverride("BBX_TEST_DETECTED_SKILL_TARGETS", target, isDetected)
		} else {
			isDetected = mcpDetected
		}
		if isDetected {
			detected = append(detected, target)
		}
	}
	if len(installed) > 0 {
		return installed, installed
	}
	if len(detected) > 0 {
		return detected, installed
	}
	fallback := []string{}
	for _, target := range installAgentNames {
		if skill || installMCPSupported(target, scope) {
			fallback = append(fallback, target)
		}
	}
	return fallback, installed
}

func installChooseTargets(scope installScope, skill bool) ([]string, []string, error) {
	fallback, installed := installDefaultTargets(scope, skill)
	info, err := os.Stdin.Stat()
	if err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return fallback, nil, nil
	}
	kind := "MCP clients"
	if skill {
		kind = "skill targets"
	}
	fmt.Fprintf(os.Stderr, "Select %s (comma-separated names, all, or none).\n", kind)
	for _, name := range installAgentNames {
		if !skill && !installMCPSupported(name, scope) {
			continue
		}
		mark := " "
		if installContains(installed, name) {
			mark = "x"
		}
		fmt.Fprintf(os.Stderr, "  [%s] %-12s %s\n", mark, name, installAgentLabels[name])
	}
	fmt.Fprintf(os.Stderr, "Selection [%s]: ", strings.Join(installed, ","))
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		return fallback, nil, nil
	}
	line = strings.TrimSpace(line)
	selected := installed
	if line == "none" {
		selected = []string{}
	} else if line != "" {
		selected, err = installParseTargets(line, skill)
		if err != nil {
			return nil, nil, err
		}
		if !skill && installSelectsAll(line) {
			available := []string{}
			for _, target := range selected {
				if installMCPSupported(target, scope) {
					available = append(available, target)
				}
			}
			selected = available
		}
	}
	removed := []string{}
	for _, name := range installed {
		if !installContains(selected, name) {
			removed = append(removed, name)
		}
	}
	if len(removed) > 0 {
		fmt.Fprintf(os.Stderr, "Remove Browser Bridge from %s? [y/N] ", strings.Join(removed, ", "))
		answer, err := reader.ReadString('\n')
		if err != nil || !strings.EqualFold(strings.TrimSpace(answer), "y") {
			removed = nil
		}
	}
	return selected, removed, nil
}

func handleSetupCommand(ctx context.Context, c config, args []string) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	switch args[0] {
	case "install":
		return true, installNativeCommand(ctx, c, args[1:])
	case "uninstall":
		if len(args) > 1 {
			return true, errors.New("usage: bbx uninstall")
		}
		return true, installUninstallAll(ctx, c)
	case "install-mcp", "install-skill":
		skill := args[0] == "install-skill"
		scope, targets, err := installParseAgentArgs(args[1:], skill)
		if err != nil {
			return true, err
		}
		var removed []string
		if targets == nil {
			targets, removed, err = installChooseTargets(scope, skill)
			if err != nil {
				return true, err
			}
		}
		if !skill {
			for _, target := range targets {
				if err := installValidateMCPScope(target, scope); err != nil {
					return true, err
				}
			}
		}
		for _, remove := range []bool{true, false} {
			current := targets
			if remove {
				current = removed
			}
			if skill && !remove {
				if err := ctx.Err(); err != nil {
					return true, err
				}
				paths, err := installAgentSkills(current, scope)
				if err != nil {
					return true, err
				}
				for _, path := range paths {
					fmt.Println("Wrote", path)
				}
				continue
			}
			for _, target := range current {
				if err := ctx.Err(); err != nil {
					return true, err
				}
				var paths []string
				if skill {
					paths, err = installAgentSkill(target, scope, remove)
				} else {
					paths, err = installAgentMCP(target, scope, remove)
				}
				if err != nil {
					return true, err
				}
				verb := "Wrote"
				if remove {
					verb = "Removed"
				}
				for _, path := range paths {
					fmt.Println(verb, path)
				}
			}
		}
		return true, nil
	}
	return false, nil
}

func installNativeCommand(ctx context.Context, c config, args []string) error {
	browsers := []string{}
	extensionID := ""
	remove, all, preserve := false, false, false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch arg {
		case "--all":
			all = true
		case "--uninstall":
			remove = true
		case "--preserve-origins":
			preserve = true
		case "--browser":
			if i+1 >= len(args) {
				return errors.New("--browser requires a value")
			}
			i++
			browser := args[i]
			if !installContains(installBrowsers, browser) {
				return fmt.Errorf("unsupported browser %q; supported: %s", browser, strings.Join(installBrowsers, ", "))
			}
			if !installContains(browsers, browser) {
				browsers = append(browsers, browser)
			}
		default:
			if strings.HasPrefix(arg, "--browser=") {
				browser := strings.TrimPrefix(arg, "--browser=")
				if !installContains(installBrowsers, browser) {
					return fmt.Errorf("unsupported browser %q", browser)
				}
				if !installContains(browsers, browser) {
					browsers = append(browsers, browser)
				}
				continue
			}
			if extensionID != "" || strings.HasPrefix(arg, "-") {
				return fmt.Errorf("unexpected install argument %q", arg)
			}
			var err error
			extensionID, err = installParseExtensionID(arg)
			if err != nil {
				return err
			}
		}
	}
	if remove && extensionID != "" {
		return errors.New("extension ID cannot be combined with --uninstall")
	}
	if all {
		browsers = installBrowsers
	}
	if len(browsers) == 0 {
		browsers = []string{installDefaultBrowser()}
	}
	for _, browser := range browsers {
		if err := ctx.Err(); err != nil {
			return err
		}
		if remove {
			paths, err := uninstallNativeRegistration(ctx, browser)
			if err != nil {
				return err
			}
			for _, path := range paths {
				fmt.Println("Removed", path)
			}
		} else {
			result, err := installNativeRegistration(ctx, c, browser, extensionID, preserve)
			if err != nil {
				return err
			}
			fmt.Println("Wrote", result.text("manifestPath"))
			fmt.Println("Wrote", result.text("launcherPath"))
		}
	}
	if !remove {
		running, err := stopLocalDaemon(ctx, c)
		if err != nil {
			return err
		}
		if running {
			if _, err := startLocalDaemon(ctx, c); err != nil {
				return err
			}
			fmt.Println("Restarted Browser Bridge daemon to use the updated install.")
		}
	}
	return nil
}

func installUninstallAll(ctx context.Context, c config) error {
	if _, err := stopLocalDaemon(ctx, c); err != nil {
		return err
	}
	scope, err := installCurrentScope()
	if err != nil {
		return err
	}
	for _, global := range []bool{true, false} {
		scope.global = global
		for _, target := range installAgentNames {
			if err := ctx.Err(); err != nil {
				return err
			}
			if installMCPSupported(target, scope) {
				paths, err := installAgentMCP(target, scope, true)
				if err != nil {
					return err
				}
				for _, path := range paths {
					fmt.Println("Removed Browser Bridge from", path)
				}
			}
			paths, err := installAgentSkill(target, scope, true)
			if err != nil {
				return err
			}
			for _, path := range paths {
				fmt.Println("Removed managed skill files from", path)
			}
		}
	}
	for _, browser := range installBrowsers {
		paths, err := uninstallNativeRegistration(ctx, browser)
		if err != nil {
			return err
		}
		for _, path := range paths {
			fmt.Println("Removed", path)
		}
	}
	// Retain logs, remote destinations, artifacts and other user data.
	for _, name := range []string{"native-host-launcher.sh", "native-host-launcher.cmd"} {
		path := filepath.Join(c.home, name)
		if err := os.Remove(path); err == nil {
			fmt.Println("Removed", path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
