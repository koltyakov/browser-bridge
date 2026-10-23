package bridge

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

// Main runs the CLI, native host, daemon, or MCP server selected by arguments.
func Main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	args := os.Args[1:]
	internalMode := len(args) > 0 && (args[0] == "--native-host" || args[0] == "--bridge-daemon" || strings.HasPrefix(args[0], "chrome-extension://"))
	if !internalMode {
		switch strings.TrimSuffix(strings.ToLower(filepath.Base(os.Args[0])), ".exe") {
		case "bbx-mcp":
			args = append([]string{"mcp", "serve"}, args...)
		case "bbx-daemon":
			args = append([]string{"--bridge-daemon"}, args...)
		case "bbx-install":
			args = append([]string{"install"}, args...)
		}
	}
	if err := run(ctx, args); err != nil {
		var forwarded cliForwardedExit
		if errors.As(err, &forwarded) {
			os.Exit(forwarded.ExitCode())
		}
		reportCLIError(args, err, os.Stdout, os.Stderr)
		os.Exit(1)
	}
}

func printJSON(v object) error {
	return writeCLIJSONOutput(os.Stdout, value(v), true, cliTTY(os.Stdout))
}

func run(ctx context.Context, args []string) error {
	invocation := args
	remote, explicit, rest, err := extractRemote(args)
	if err != nil {
		return err
	}
	args = rest
	if len(args) > 0 && localOnlyCommand(args[0]) {
		if explicit {
			return fmt.Errorf("The --remote flag is not supported with %q.", args[0])
		}
		remote = ""
	}
	c, err := loadConfig()
	if err != nil {
		return err
	}
	if len(args) > 0 && args[0] == "install-self" {
		return cliForwardError(installSelfCommand(ctx, c, args[1:]))
	}
	if handled, err := forwardNativeUpdate(ctx, c, invocation); handled || err != nil {
		return cliForwardError(err)
	}
	if len(args) == 0 || args[0] == "--help" || args[0] == "help" || args[0] == "-h" {
		printCLIUsage()
		return nil
	}
	switch args[0] {
	case "--version", "-v":
		fmt.Println(versionName())
		return nil
	case "--self-test":
		return printJSON(object{"version": value(version), "versionName": value(versionName()), "target": value(buildTarget), "runtime": value("go"), "methodCount": value(len(catalog.Methods))})
	case "skill":
		return printJSON(catalog.Runtime)
	case "protocol.describe":
		if len(args) > 2 {
			return errors.New("usage: bbx protocol.describe [JSON]")
		}
		params := object{}
		if len(args) > 1 {
			var err error
			params, err = decodeObject([]byte(args[1]))
			if err != nil {
				return err
			}
		}
		return printCLIDescription(params)
	case "protocol":
		if len(args) < 2 || args[1] != "describe" || len(args) > 3 {
			return errors.New("usage: bbx protocol describe [method|group]")
		}
		params := object{}
		if len(args) == 3 {
			key := "group"
			if _, ok := catalog.Methods[args[2]]; ok {
				key = "method"
			}
			params[key] = value(args[2])
		}
		return printCLIDescription(params)
	}
	if handled, err := handleUpdateCommand(ctx, c, args); handled || err != nil {
		return err
	}
	if handled, err := handleSetupCommand(ctx, c, args); handled {
		return err
	}
	switch args[0] {
	case "config":
		return handleConfigCommand(c, args[1:])
	case "remote":
		return handleRemoteCommand(ctx, c, args[1:])
	case "proxy":
		return handleProxyCommand(ctx, c, args[1:])
	case "restart":
		return restartCLI(ctx, c, args[1:])
	case "doctor":
		return doctorCLI(ctx, c, args[1:])
	case "mcp":
		if len(args) != 2 || args[1] != "serve" {
			return errors.New("usage: bbx mcp serve")
		}
		if handled, err := prepareNativeClient(ctx, c, invocation); handled || err != nil {
			return cliForwardError(err)
		}
		return mcpServe(ctx, c, os.Stdin, os.Stdout)
	case "--bridge-daemon":
		return runDaemon(ctx, c)
	case "--native-host":
		return nativeHost(ctx, c, os.Stdin, os.Stdout)
	}
	if strings.HasPrefix(args[0], "chrome-extension://") {
		return nativeHost(ctx, c, os.Stdin, os.Stdout)
	}
	c, err = destinationConfig(c, remote)
	if err != nil {
		return err
	}
	if handled, err := prepareNativeClient(ctx, c, invocation); handled || err != nil {
		return cliForwardError(err)
	}
	if isFileCommand(args[0]) {
		return runFileCLI(ctx, c, args)
	}
	if _, shortcut := shortcutMethods[args[0]]; !shortcut {
		if _, method := catalog.Methods[args[0]]; !method && args[0] != "call" && args[0] != "batch" && args[0] != "eval" && args[0] != "intercept" {
			fmt.Fprintln(os.Stderr, "Unknown command: "+args[0])
			printCLIUsage()
			return cliPrintedError{}
		}
	}
	request, err := parseCLI(args)
	if err != nil {
		return err
	}
	if args[0] == "batch" {
		return runBatch(ctx, c, request)
	}
	cl, err := connect(c, "agent")
	if err != nil {
		return err
	}
	defer cl.close()
	ctx, cancel := context.WithTimeout(ctx, cliRequestTimeout())
	defer cancel()
	response, err := cl.request(ctx, request)
	if err != nil {
		return err
	}
	raw := args[0] == "call" || strings.Contains(args[0], ".")
	method := request.text("method")
	if !raw {
		method = cliShortcutPrintMethod(args[0])
	}
	return printCLIResponse(response, raw, method)
}

// A forwarded process owns its output and exit status.
type cliForwardedExit struct{ *exec.ExitError }

func cliForwardError(err error) error {
	var child *exec.ExitError
	if errors.As(err, &child) {
		return cliForwardedExit{child}
	}
	return err
}

func parseCLI(args []string) (object, error) {
	meta, params := object{"source": value("cli")}, object{}
	var tab int64
	var preset string
	rest := []string{}
	seen := map[string]bool{}
	for i := 0; i < len(args); i++ {
		key := args[i]
		if key == "--extension" || key == "--browser" || key == "--profile" || key == "--tab" || key == "--preset" {
			if seen[key] {
				return nil, fmt.Errorf("%s may only be specified once", key)
			}
			seen[key] = true
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") || strings.TrimSpace(args[i+1]) == "" {
				if key == "--preset" {
					return nil, errors.New("--preset requires a value: quick, normal, deep.")
				}
				return nil, fmt.Errorf("%s requires a value.", key)
			}
			i++
			switch key {
			case "--extension":
				meta["target_extension"] = value(args[i])
			case "--browser":
				meta["target_browser"] = value(args[i])
			case "--profile":
				meta["target_profile"] = value(args[i])
			case "--preset":
				preset = args[i]
			case "--tab":
				n, err := cliNumber(args[i], "tabId", true)
				if err != nil {
					return nil, err
				}
				if n > 9007199254740991 {
					return nil, errors.New("Request tab_id must be null or a positive safe integer.")
				}
				tab = int64(n)
			}
		} else {
			rest = append(rest, key)
		}
	}
	if len(rest) == 0 {
		return nil, errors.New("a bridge method is required")
	}
	if preset != "" {
		if _, ok := catalog.Presets[preset]; !ok {
			return nil, fmt.Errorf("Unknown preset %q. Valid presets: quick, normal, deep.", preset)
		}
	}
	method := rest[0]
	rest = rest[1:]
	if method == "call" {
		if len(rest) == 0 {
			return nil, errors.New(cliCallUsage)
		}
		method, rest = rest[0], rest[1:]
		if _, ok := catalog.Methods[method]; !ok {
			return nil, fmt.Errorf("Unknown method %q. Run bbx skill to see available methods.", method)
		}
	} else if shortcut, p, err := buildShortcut(method, rest); shortcut != "" || err != nil {
		if err != nil {
			return nil, err
		}
		method, params, rest = shortcut, p, nil
	} else if method == "intercept" {
		var err error
		method, params, err = parseIntercept(rest)
		if err != nil {
			return nil, err
		}
		rest = nil
	} else if method == "eval" {
		await := false
		expr := []string{}
		for _, s := range rest {
			if s == "--await" {
				await = true
			} else {
				expr = append(expr, s)
			}
		}
		expression := strings.Join(expr, " ")
		if expression == "" || expression == "-" {
			raw, err := readCLIInput("-")
			if err != nil {
				return nil, err
			}
			expression = strings.TrimSpace(string(raw))
		}
		if expression == "" {
			return nil, errors.New(`Usage: eval [--tab <id>] [--await] <expression>  (or pipe via stdin: echo "expr" | bbx eval -)`)
		}
		method = "page.evaluate"
		params = object{"expression": value(expression), "returnByValue": value(true)}
		if await {
			params["awaitPromise"] = value(true)
		}
		rest = nil
	}
	if method != "batch" {
		if _, ok := catalog.Methods[method]; !ok {
			return nil, fmt.Errorf("unknown method or command: %s", method)
		}
	}
	if len(rest) > 1 {
		return nil, errors.New(cliCallUsage)
	}
	if method == "batch" && len(rest) == 0 {
		return nil, errors.New(`Usage: batch '[{"method":"...","params":{...}}, ...]'`)
	}
	if len(rest) == 1 {
		raw := []byte(rest[0])
		if rest[0] == "-" {
			var err error
			raw, err = readCLIInput("-")
			if err != nil {
				return nil, err
			}
		}
		if len(raw) > maxMessageBytes {
			return nil, errors.New("JSON input exceeds 1 MiB")
		}
		if method == "batch" {
			if len(meta) > 1 || tab != 0 {
				return nil, errors.New("batch routing and budgets must be specified on each call")
			}
			return object{"calls": raw, "preset": value(preset)}, nil
		}
		var err error
		params, err = parseCLIJSONObject(raw)
		if err != nil {
			return nil, err
		}
	}
	if preset != "" {
		defaults, ok := catalog.Presets[preset]
		if !ok {
			return nil, errors.New("preset must be quick, normal, or deep")
		}
		for key, v := range defaults[method] {
			if _, exists := params[key]; !exists {
				params[key] = v
			}
		}
	}
	if !catalog.Methods[method].boolean("tab") {
		tab = 0
	}
	return newRequest(method, params, meta, tab), nil
}

func runBatch(ctx context.Context, c config, request object) error {
	calls, invalid, err := prepareCLIBatch(request["calls"], request.text("preset"))
	if err != nil {
		return err
	}
	if invalid != nil {
		if err := writeCLIJSONOutput(os.Stdout, value(invalid), true, cliTTY(os.Stdout)); err != nil {
			return err
		}
		return cliPrintedError{}
	}
	cl, err := connect(c, "agent")
	if err != nil {
		return err
	}
	defer cl.close()
	results := make([]object, len(calls))
	jobs := make(chan int)
	done := make(chan struct{}, protocol.MaxBatchConcurrency)
	for worker := 0; worker < protocol.MaxBatchConcurrency; worker++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for i := range jobs {
				call := calls[i]
				meta := object{"source": value("cli")}
				for key, dest := range map[string]string{"extensionId": "target_extension", "targetBrowser": "target_browser", "targetProfile": "target_profile"} {
					if v, ok := call[key]; ok {
						meta[dest] = v
					}
				}
				tab := call.number("tabId")
				if !catalog.Methods[call.text("method")].boolean("tab") {
					tab = 0
				}
				started := time.Now()
				callCtx, cancel := context.WithTimeout(ctx, cliRequestTimeout())
				response, err := cl.request(callCtx, newRequest(call.text("method"), call.object("params"), meta, tab))
				cancel()
				results[i] = cliBatchResult(call.text("method"), tab, response, err, time.Since(started).Milliseconds(), time.Now().UnixMilli())
			}
		}()
	}
	for i := range calls {
		jobs <- i
	}
	close(jobs)
	for worker := 0; worker < protocol.MaxBatchConcurrency; worker++ {
		<-done
	}
	if err := writeCLIJSONOutput(os.Stdout, value(results), true, cliTTY(os.Stdout)); err != nil {
		return err
	}
	for _, r := range results {
		if !r.boolean("ok") {
			return cliPrintedError{}
		}
	}
	return nil
}

func extractRemote(args []string) (string, bool, []string, error) {
	remote := os.Getenv("BBX_REMOTE")
	explicit := false
	rest := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] != "--remote" {
			rest = append(rest, args[i])
			continue
		}
		if explicit {
			return "", false, nil, errors.New("--remote may only be specified once")
		}
		i++
		if i >= len(args) || strings.HasPrefix(args[i], "--") || strings.TrimSpace(args[i]) == "" {
			return "", false, nil, errors.New("--remote requires a destination name (see `bbx remote list`).")
		}
		remote = args[i]
		explicit = true
	}
	return remote, explicit, rest, nil
}
func localOnlyCommand(s string) bool {
	if command := cliCommandByName(s); command != nil {
		return command.localOnly
	}
	return strings.HasPrefix(s, "chrome-extension://")
}
func cliRequestTimeout() time.Duration {
	n, e := strconv.Atoi(os.Getenv("BBX_CLIENT_REQUEST_TIMEOUT_MS"))
	if e == nil && n > 0 {
		return time.Duration(n) * time.Millisecond
	}
	return protocol.MaxClientRequestTimeoutMS * time.Millisecond
}
func readCLIInput(s string) ([]byte, error) {
	if s != "-" {
		return []byte(s), nil
	}
	if cliTTY(os.Stdin) {
		return []byte{}, nil
	}
	b, e := io.ReadAll(io.LimitReader(os.Stdin, maxMessageBytes+1))
	if e == nil && len(b) > maxMessageBytes {
		e = errors.New("input exceeds 1 MiB")
	}
	return []byte(strings.TrimSpace(string(b))), e
}
func printCLIResponse(response object, raw bool, method string) error {
	return writeCLIResponse(response, raw, method, time.Now().UnixMilli(), os.Stdout, os.Stderr, cliTTY(os.Stdout), cliTTY(os.Stderr))
}
func writeCLIResponse(response object, raw bool, method string, now int64, out, stderr io.Writer, pretty, color bool) error {
	if raw {
		if response.boolean("ok") {
			return writeCLIJSONOutput(out, response["result"], method != "sensitive.read", pretty)
		}
		e := response.object("error")
		message := cliANSI.ReplaceAllString(e.text("code")+": "+e.text("message"), "")
		if color {
			message = "\x1b[31m" + message + "\x1b[0m"
		}
		_, _ = fmt.Fprintln(stderr, message)
		if err := writeCLIJSONOutput(out, value(response), true, pretty); err != nil {
			return err
		}
		return cliPrintedError{}
	}
	if err := writeCLIJSONOutput(out, value(cliAnnotate(cliSummarize(response, method, now), response)), true, pretty); err != nil {
		return err
	}
	if !response.boolean("ok") {
		return cliPrintedError{}
	}
	return nil
}
func invokeCLI(ctx context.Context, cl *client, route object, method string, params object) (object, error) {
	response, err := requestCLIResponse(ctx, cl, route, method, params)
	if err != nil {
		return nil, err
	}
	if !response.boolean("ok") {
		return nil, cliBridgeError{response}
	}
	return response.object("result"), nil
}
func requestCLIResponse(ctx context.Context, cl *client, route object, method string, params object) (object, error) {
	meta := object{"source": value("cli")}
	var tab int64
	if route != nil {
		if m := route.object("meta"); m != nil {
			meta = m
		}
		tab = route.number("tab_id")
	}
	if !catalog.Methods[method].boolean("tab") {
		tab = 0
	}
	callCtx, cancel := context.WithTimeout(ctx, cliRequestTimeout())
	defer cancel()
	response, err := cl.request(callCtx, newRequest(method, params, meta, tab))
	if err != nil {
		return nil, err
	}
	return response, nil
}
func printCLIUsage() {
	fmt.Println("Usage: bbx [--remote <name>] <command> [args]")
	for _, category := range []string{"Setup", "Updates", "Configuration", "Destinations", "RPC", "Batch", "Protocol", "Files", "Other commands"} {
		fmt.Printf("\n%s:\n", category)
		for _, command := range cliCommands {
			if command.category == category {
				fmt.Println("  " + command.usage)
			}
		}
	}
	fmt.Println("\nShortcuts:")
	keys := make([]string, 0, len(shortcutMethods))
	for key := range shortcutMethods {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		fmt.Printf("  %-18s %s\n", key, shortcutMethods[key])
	}
}

func printCLIDescription(params object) error {
	_, hasMethod := params["method"]
	_, hasGroup := params["group"]
	if hasMethod && hasGroup {
		return errors.New("describe accepts either method or group, not both")
	}
	if method := params.text("method"); hasMethod {
		if _, ok := catalog.Methods[method]; !ok {
			return fmt.Errorf("unknown bridge method: %s", method)
		}
		return printJSON(describeMethod(method, catalog.Methods[method]))
	}
	if group := params.text("group"); hasGroup {
		methods := []object{}
		for _, entry := range catalog.Methods {
			if entry.text("group") == group {
				methods = append(methods, entry)
			}
		}
		if len(methods) == 0 {
			return fmt.Errorf("unknown bridge method group: %s", group)
		}
		sort.Slice(methods, func(i, j int) bool { return methods[i].text("method") < methods[j].text("method") })
		return printJSON(object{"group": value(group), "methods": value(methods)})
	}
	counts := map[string]int{}
	for _, entry := range catalog.Methods {
		counts[entry.text("group")]++
	}
	groups := []object{}
	for group, count := range counts {
		groups = append(groups, object{"group": value(group), "count": value(count)})
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].text("group") < groups[j].text("group") })
	return printJSON(object{"groups": value(groups)})
}
