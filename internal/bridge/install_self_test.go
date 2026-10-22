package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestInstallSelfReplacesLinksWithoutChangingTargets(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require Windows developer mode")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	installTestWrite(t, source, "new executable")
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"bbx", "bbx-mcp", "bbx-daemon", "bbx-install"} {
		target := filepath.Join(dir, name+".js")
		installTestWrite(t, target, "npm wrapper")
		if err := os.Symlink(target, filepath.Join(bin, name)); err != nil {
			t.Fatal(err)
		}
	}
	installed, err := installSelfFiles(source, bin)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(installed)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0755 {
		t.Fatalf("installed executable: %v, %v", info, err)
	}
	for _, name := range []string{"bbx", "bbx-mcp", "bbx-daemon", "bbx-install"} {
		wrapper, err := os.ReadFile(filepath.Join(dir, name+".js"))
		if err != nil || string(wrapper) != "npm wrapper" {
			t.Fatalf("changed npm wrapper %s: %q, %v", name, wrapper, err)
		}
		if name != "bbx" {
			link, err := os.Readlink(filepath.Join(bin, name))
			if err != nil || link != "bbx" {
				t.Fatalf("alias %s is not a relative link: %q %v", name, link, err)
			}
		}
	}
	// An already-open image keeps its bytes while a second install publishes
	// the replacement. This also protects running Unix daemon/native hosts.
	old, err := os.Open(installed)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	installTestWrite(t, source, "second executable")
	if _, err := installSelfFiles(source, bin); err != nil {
		t.Fatal(err)
	}
	oldBytes, _ := io.ReadAll(old)
	newBytes, _ := os.ReadFile(installed)
	if string(oldBytes) != "new executable" || string(newBytes) != "second executable" {
		t.Fatalf("non-atomic replacement: old %q, new %q", oldBytes, newBytes)
	}
	if err := installSelfCopy(filepath.Join(dir, "missing"), installed); err == nil {
		t.Fatal("accepted missing source")
	}
	newBytes, _ = os.ReadFile(installed)
	if string(newBytes) != "second executable" {
		t.Fatal("failed copy damaged installed executable")
	}
}

func TestInstallSelfClearsOnlyNativeSelection(t *testing.T) {
	c, _ := installTestScope(t)
	root, err := updatePrepareRoot(c.home)
	if err != nil {
		t.Fatal(err)
	}
	record := updateInstalled{Instance: uniqueID(), Version: "9.0.0", Target: "go-linux-amd64", SHA256: strings.Repeat("a", 64), Size: 1, ManifestDigest: strings.Repeat("b", 64)}
	state := updateState{SchemaVersion: 1, Current: &record, Previous: &record, RollbackFrom: "10.0.0", HighestSequence: 42, HighestDigest: strings.Repeat("c", 64), BlockedVersions: []string{"10.0.0"}}
	if err := updateSaveState(root, state); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(root, "state.json"))
	settings := filepath.Join(c.home, "config.json")
	installTestWrite(t, settings, `{"autoUpdate":"compatible","custom":"keep"}`)
	changed, err := installSelfClearSelection(context.Background(), c)
	if err != nil || !changed {
		t.Fatalf("clear selection: %v, %v", changed, err)
	}
	after, err := updateLoadState(root)
	if err != nil || after.Current != nil || after.RollbackFrom != "" || after.Previous == nil || *after.Previous != record || after.HighestSequence != 42 || after.HighestDigest != state.HighestDigest || len(after.BlockedVersions) != 1 {
		t.Fatalf("state changed unexpectedly: %+v, %v", after, err)
	}
	backup, _ := os.ReadFile(filepath.Join(root, "state.before-install-self.json"))
	if !bytes.Equal(before, backup) {
		t.Fatal("lost previous selection backup")
	}
	settingsBytes, _ := os.ReadFile(settings)
	if string(settingsBytes) != `{"autoUpdate":"compatible","custom":"keep"}` {
		t.Fatal("changed user settings")
	}
	if changed, err := installSelfClearSelection(context.Background(), c); err != nil || changed {
		t.Fatalf("repeat install changed state: %v, %v", changed, err)
	}
}

func TestInstallSelfLocalEscapeAndEnvironment(t *testing.T) {
	c, _ := installTestScope(t)
	installTestWrite(t, filepath.Join(c.home, "native-update", "state.json"), "broken")
	t.Setenv("BBX_NPM_VERSION", "")
	t.Setenv("BBX_AUTO_UPDATE", "invalid-policy")
	t.Setenv("BBX_REMOTE", "missing-destination")
	if err := run(context.Background(), []string{"install-self", "--invalid"}); err == nil || err.Error() != installSelfUsage {
		t.Fatalf("management escape failed: %v", err)
	}
	if err := run(context.Background(), []string{"--remote", "x", "install-self"}); err == nil || !strings.Contains(err.Error(), "--remote flag is not supported") {
		t.Fatalf("accepted explicit remote: %v", err)
	}
	env := installSelfEnvironment([]string{"BBX_NPM_VERSION=1.0.0", "BBX_REMOTE=x", "BBX_AUTO_UPDATE=compatible", "BROWSER_BRIDGE_HOME=keep", "OTHER=keep"})
	if strings.Join(env, ";") != "BROWSER_BRIDGE_HOME=keep;OTHER=keep;BBX_AUTO_UPDATE=off" {
		t.Fatal(env)
	}
}

func TestInstallSelfStopsLegacyDaemonAfterAuthentication(t *testing.T) {
	if os.Getenv("BBX_TEST_LEGACY_DAEMON") == "1" {
		version = "0.0.0"
		c, err := loadConfig()
		if err == nil {
			err = runDaemon(context.Background(), c)
		}
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	installTestScope(t)
	t.Setenv("BBX_AUTH_TOKEN_FILE", "")
	t.Setenv("BBX_AUTH_TOKEN", "")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	listener.Close()
	t.Setenv("BBX_TCP_PORT", port)
	c, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestInstallSelfStopsLegacyDaemonAfterAuthentication$")
	child.Env = append(os.Environ(), "BBX_TEST_LEGACY_DAEMON=1")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer child.Wait()
	defer child.Process.Kill()
	installSelfWait(t, func() bool { _, err := daemonPID(c); return err == nil })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cl, err := connect(c, "agent")
	if err != nil {
		t.Fatal(err)
	}
	_, err = invokeCLI(ctx, cl, nil, "health.ping", object{})
	cl.close()
	if err == nil || !strings.Contains(err.Error(), "protocol majors") {
		t.Fatalf("expected incompatible legacy health: %v", err)
	}
	wrong := c
	wrong.token = strings.Repeat("x", 32)
	if _, err := stopLocalDaemon(ctx, wrong); err == nil || !processRunning(child.Process.Pid) {
		t.Fatalf("unauthenticated stop was accepted: %v", err)
	}
	if running, err := stopLocalDaemon(ctx, c); err != nil || !running {
		t.Fatalf("authenticated legacy stop failed: %v, %v", running, err)
	}
}

func installSelfWait(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out waiting for installation process")
}

func TestInstallSelfCLI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native registration changes the user's registry")
	}
	// Build before changing HOME so the test retains the developer's Go cache.
	source := filepath.Join(t.TempDir(), "bbx")
	build := exec.Command("go", "build", "-o", source, "../../cmd/bbx")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	_, scope := installTestScope(t)
	t.Setenv("BBX_AUTH_TOKEN_FILE", "")
	t.Setenv("BBX_AUTH_TOKEN", "")
	t.Setenv("BBX_AUTO_UPDATE", "off")
	t.Setenv("BROWSER_BRIDGE_EXTENSION_ID", publishedExtensionID)
	t.Setenv("BBX_NPM_VERSION", version)
	t.Setenv("BBX_REMOTE", "ignored-ambient-remote")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	listener.Close()
	t.Setenv("BBX_TCP_PORT", port)
	c, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(scope.home, ".local", "bin")
	installed := filepath.Join(bin, "bbx")
	runInstall := func(args ...string) object {
		t.Helper()
		command := exec.Command(source, append([]string{"install-self"}, args...)...)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("install: %v\n%s", err, output)
		}
		result, err := decodeObject(output)
		if err != nil || !result.boolean("ok") {
			t.Fatalf("install result: %s, %v", output, err)
		}
		return result.object("evidence")
	}
	first := runInstall("--no-restart")
	if first.text("executable") != installed || !first.boolean("restartSkipped") {
		t.Fatal(first)
	}
	if _, err := c.dial(); err == nil {
		t.Fatal("--no-restart started a daemon")
	}
	var registrations []object
	if err := json.Unmarshal(first["nativeRegistrations"], &registrations); err != nil || len(registrations) != 1 || registrations[0].text("browser") != installDefaultBrowser() {
		t.Fatalf("default registration: %v, %v", registrations, err)
	}
	launcher, _ := os.ReadFile(registrations[0].text("launcherPath"))
	if !bytes.Contains(launcher, []byte(installShellQuote(installed))) || bytes.Contains(launcher, []byte("BBX_NPM_VERSION")) || bytes.Contains(launcher, []byte(source)) {
		t.Fatalf("launcher did not select installed executable: %s", launcher)
	}
	origins := []string{"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/", "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"}
	for _, browser := range []string{"chrome", "edge"} {
		path := filepath.Join(installManifestDir(runtime.GOOS, scope.home, browser, os.Getenv), hostName+".json")
		installTestWrite(t, path, string(value(object{"allowed_origins": value(origins), "custom": value("keep")})))
	}
	// Exercise real argv0 aliases and keep native/MCP clients alive across install.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	daemon := exec.CommandContext(ctx, filepath.Join(bin, "bbx-daemon"))
	daemon.Env = installSelfEnvironment(os.Environ())
	daemon.Stderr = os.Stderr
	daemon.Stdout = os.Stdout
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	defer daemon.Wait()
	defer daemon.Process.Kill()
	installSelfWait(t, func() bool {
		_, err := daemonPID(c)
		if !processRunning(daemon.Process.Pid) {
			t.Fatalf("daemon exited before PID publication: %v", err)
		}
		return err == nil
	})
	oldPID, _ := daemonPID(c)
	t.Cleanup(func() {
		stopCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if _, err := stopLocalDaemon(stopCtx, c); err != nil {
			t.Error(err)
		}
	})
	startRole := func(path string, args ...string) (<-chan error, io.WriteCloser, io.ReadCloser) {
		t.Helper()
		cmd := exec.CommandContext(ctx, path, args...)
		cmd.Env = installSelfEnvironment(os.Environ())
		input, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		output, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		t.Cleanup(func() { input.Close(); _ = cmd.Process.Kill() })
		return done, input, output
	}
	mcpDone, _, _ := startRole(filepath.Join(bin, "bbx-mcp"))
	nativeDone, nativeInput, nativeOutput := startRole(installed, "--native-host")
	go func() {
		writer := wireWriter{out: nativeInput, native: true}
		for {
			request, err := readNative(nativeOutput)
			if err != nil {
				return
			}
			if request.text("method") == "health.ping" {
				_ = writer.send(success(request.text("id"), object{}))
			}
		}
	}()
	installSelfWait(t, func() bool {
		entries, _ := os.ReadDir(filepath.Join(c.home, "mcp-processes"))
		return len(entries) == 1
	})
	installSelfWait(t, func() bool {
		cl, err := connect(c, "agent")
		if err != nil {
			return false
		}
		defer cl.close()
		health, err := invokeCLI(ctx, cl, nil, "health.ping", object{})
		return err == nil && health.boolean("extensionConnected")
	})
	second := runInstall("--bin-dir", bin)
	if !second.boolean("previouslyRunning") || second.number("pid") == int64(oldPID) || second.object("mcpProcesses").number("restartRequested") != 1 {
		t.Fatalf("restart evidence: %s", value(second))
	}
	for role, done := range map[string]<-chan error{"MCP": mcpDone, "native": nativeDone} {
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("old %s process did not exit", role)
		}
	}
	for _, browser := range []string{"chrome", "edge"} {
		path := filepath.Join(installManifestDir(runtime.GOOS, scope.home, browser, os.Getenv), hostName+".json")
		raw, _ := os.ReadFile(path)
		manifest, err := decodeObject(raw)
		var got []string
		_ = json.Unmarshal(manifest["allowed_origins"], &got)
		if err != nil || manifest.text("custom") != "keep" || strings.Join(got, ",") != strings.Join(origins, ",") {
			t.Fatalf("manifest changed: %s, %v", raw, err)
		}
	}
	alias := exec.Command(filepath.Join(bin, "bbx-install"), "--invalid")
	alias.Env = installSelfEnvironment(os.Environ())
	if output, err := alias.CombinedOutput(); err == nil || !bytes.Contains(output, []byte("unexpected install argument")) {
		t.Fatalf("install alias role: %s, %v", output, err)
	}
}
