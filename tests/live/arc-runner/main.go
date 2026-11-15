package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type runReport struct {
	OK           bool               `json:"ok"`
	RunDirectory string             `json:"runDirectory"`
	Stages       verificationStages `json:"stages"`
	Error        string             `json:"error,omitempty"`
	CleanupError string             `json:"cleanupError,omitempty"`
}

type arcRunner struct {
	root, home, browser, executable, extension, bridgeHome string
	env                                                    []string
	sources                                                launchSources
	selected                                               endpoint
	isolation                                              isolationProof
	client                                                 *devTools
	probe                                                  manifestProof
	children                                               []*exec.Cmd
	logs                                                   []*os.File
	manifests                                              []string
	startupTimeout, stageTimeout                           time.Duration
}

func main() {
	if len(os.Args) == 5 && os.Args[1] == "--probe-host" {
		if err := serveProbeHost(os.Stdout, os.Stdin, nativeReply{Location: os.Args[2], Nonce: os.Args[3]}, os.Args[4]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := runMain(); err != nil {
		os.Exit(1)
	}
}

// Echoing a per-run nonce proves that Chrome executed this host. No daemon or
// real Browser Bridge registration is involved in the native-lookup stage.
func serveProbeHost(output io.Writer, input io.Reader, reply nativeReply, expectedRole string) error {
	if expectedRole != "arc-lookup" {
		return errors.New("invalid diagnostic host role")
	}
	data, err := json.Marshal(reply)
	if err != nil {
		return err
	}
	if err := binary.Write(output, binary.LittleEndian, uint32(len(data))); err != nil {
		return err
	}
	if _, err := output.Write(data); err != nil {
		return err
	}
	_, err = io.Copy(io.Discard, input)
	return err
}

func runMain() error {
	browser := flag.String("browser", os.Getenv("BBX_ARC_BROWSER"), "Explicit Arc.app executable")
	executable := flag.String("bbx", "dist/cli/bbx", "Workspace Go BBX executable")
	extension := flag.String("extension", "dist/ext", "Built extension to copy for the bridge stage")
	output := flag.String("output", "dist/arc-live", "Parent directory for fresh per-run evidence")
	startup := flag.Duration("startup-timeout", 30*time.Second, "Discovery and isolation deadline per stage")
	stageTimeout := flag.Duration("stage-timeout", 20*time.Second, "Connection and native verification deadline per stage")
	flag.Parse()
	report := runReport{Stages: initialStages()}
	err := func() error {
		if runtime.GOOS != "darwin" || *browser == "" {
			return errors.New("Arc verification requires macOS and an explicit --browser or BBX_ARC_BROWSER")
		}
		if *startup <= 0 || *startup > 2*time.Minute || *stageTimeout <= 0 || *stageTimeout > 2*time.Minute {
			return errors.New("stage deadlines must be positive and at most two minutes")
		}
		r, err := prepareRunner(*browser, *executable, *extension, *output)
		if err != nil {
			return err
		}
		report.RunDirectory = r.root
		r.startupTimeout, r.stageTimeout = *startup, *stageTimeout
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
		defer cancel()
		report.Stages, err = verifyStages(ctx, r.plan())
		if cleanupErr := r.close(); cleanupErr != nil {
			report.CleanupError = cleanupErr.Error()
			err = errors.Join(err, cleanupErr)
		}
		return err
	}()
	report.OK = err == nil
	if err != nil {
		report.Error = err.Error()
	}
	data, marshalErr := json.MarshalIndent(report, "", "  ")
	if marshalErr != nil {
		return marshalErr
	}
	data = append(data, '\n')
	if report.RunDirectory != "" {
		if writeErr := os.WriteFile(filepath.Join(report.RunDirectory, "result.json"), data, 0600); writeErr != nil {
			fmt.Fprintln(os.Stderr, writeErr)
			err = errors.Join(err, writeErr)
		}
	}
	_, printErr := os.Stdout.Write(data)
	return errors.Join(err, printErr)
}

func prepareRunner(browser, executable, extension, output string) (*arcRunner, error) {
	paths := []*string{&browser, &executable, &extension}
	for _, destination := range paths {
		resolved, err := filepath.Abs(*destination)
		if err != nil {
			return nil, err
		}
		resolved, err = filepath.EvalSymlinks(resolved)
		if err != nil {
			return nil, err
		}
		*destination = resolved
	}
	processes, err := exec.Command("/bin/ps", "-axo", "comm").Output()
	if err != nil {
		return nil, err
	}
	for _, process := range strings.Split(string(processes), "\n") {
		if strings.TrimSpace(process) == browser {
			return nil, errors.New("Arc is already running; refusing to reuse an existing instance")
		}
	}
	output, err = filepath.Abs(output)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(output, 0700); err != nil {
		return nil, err
	}
	root, err := os.MkdirTemp(output, "run-")
	if err != nil {
		return nil, err
	}
	r := &arcRunner{root: root, home: filepath.Join(root, "home"), bridgeHome: filepath.Join(root, "bridge"), browser: browser, executable: executable, extension: extension}
	if err := os.MkdirAll(r.home, 0700); err != nil {
		return nil, err
	}
	// A private loopback TCP transport avoids macOS's short Unix-socket path
	// limit when the disposable HOME is beneath a long evidence directory.
	port, err := privatePort()
	if err != nil {
		return nil, err
	}
	r.env = isolatedEnvironment(os.Environ(), r.home, r.bridgeHome, port)
	return r, nil
}

func isolatedEnvironment(base []string, home, bridgeHome, port string) []string {
	result := []string{}
	for _, entry := range base {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "BBX_") || strings.HasPrefix(key, "BROWSER_BRIDGE_") ||
			key == "HOME" || key == "CFFIXED_USER_HOME" || key == "CHROME_CONFIG_HOME" || key == "CHROME_USER_DATA_DIR" {
			continue
		}
		result = append(result, entry)
	}
	return append(result, "HOME="+home, "CFFIXED_USER_HOME="+home,
		"BROWSER_BRIDGE_HOME="+bridgeHome, "BBX_AUTO_UPDATE=off",
		"BBX_TCP_HOST=127.0.0.1", "BBX_TCP_BIND_HOST=127.0.0.1", "BBX_TCP_PORT="+port)
}

func (r *arcRunner) launchBrowser() error {
	logPath := filepath.Join(r.root, "browser.log")
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	r.logs = append(r.logs, log)
	profiles := []string{
		filepath.Join(r.root, "requested-profile"),
		filepath.Join(r.home, "Library", "Application Support", "Arc", "User Data"),
	}
	r.sources, err = captureSources(r.root, logPath, profiles)
	if err != nil {
		return err
	}
	args := []string{
		"--user-data-dir=" + profiles[0], "--remote-debugging-port=0",
		"--remote-allow-origins=http://127.0.0.1", "--enable-automation",
		"--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
		"--disable-background-networking", "--disable-component-update", "--disable-sync",
		"--enable-logging=stderr", "about:blank",
	}
	cmd := exec.Command(r.browser, args...)
	cmd.Env, cmd.Stdout, cmd.Stderr = r.env, log, log
	ownProcess(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	r.children = append(r.children, cmd)
	return nil
}

func bounded(timeout time.Duration, operation stageOperation) stageOperation {
	return func(ctx context.Context) (json.RawMessage, error) {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		return operation(ctx)
	}
}

func (r *arcRunner) plan() verificationPlan {
	return verificationPlan{
		discover: bounded(r.startupTimeout, func(ctx context.Context) (json.RawMessage, error) {
			if err := r.launchBrowser(); err != nil {
				return nil, err
			}
			var err error
			r.selected, err = r.sources.discover(ctx)
			data, _ := json.Marshal(r.selected)
			return data, err
		}),
		isolate: bounded(r.startupTimeout, func(ctx context.Context) (json.RawMessage, error) {
			var err error
			r.isolation, err = r.sources.verifyIsolation(ctx, r.selected)
			data, _ := json.Marshal(r.isolation)
			return data, err
		}),
		connect:        bounded(r.stageTimeout, r.connectEndpoint),
		createManifest: bounded(r.stageTimeout, r.createProbeManifest),
		lookup:         bounded(r.stageTimeout, r.lookupNativeHost),
		bridge:         bounded(r.stageTimeout, r.connectBridge),
	}
}

func (r *arcRunner) close() error {
	var failures []error
	if r.client != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, _ = r.client.command(ctx, "Browser.close", nil, "")
		cancel()
		_ = r.client.socket.Close()
	}
	for i := len(r.children) - 1; i >= 0; i-- {
		if err := stopOwnedProcess(r.children[i]); err != nil {
			failures = append(failures, err)
		}
	}
	for _, file := range r.logs {
		if err := file.Close(); err != nil {
			failures = append(failures, err)
		}
	}
	for _, file := range r.manifests {
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
