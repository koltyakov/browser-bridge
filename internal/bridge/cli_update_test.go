package bridge

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func cliUpdateTestHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("BROWSER_BRIDGE_HOME", home)
	for _, key := range []string{"BBX_TCP_PORT", "BBX_TCP_HOST", "BBX_TCP_BIND_HOST", "BBX_AUTH_TOKEN_FILE", "BBX_REMOTE"} {
		t.Setenv(key, "")
	}
	return home
}

func TestCLIUpdateDispatchAndPreflightScope(t *testing.T) {
	home := cliUpdateTestHome(t)
	// A rejected policy identifies preflight without opening a daemon connection.
	t.Setenv("BBX_AUTO_UPDATE", "invalid-test-policy")
	t.Setenv("BBX_REMOTE", "missing-ambient-destination")
	for _, args := range [][]string{{"--help"}, {"--version"}, {"--self-test"}, {"protocol", "describe", "health.ping"}, {"remote", "list"}, {"proxy", "status"}, {"update", "status"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			if err := run(context.Background(), args); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, args := range [][]string{{"update", "status", "--remote", "local"}, {"--remote", "selected", "update", "status"}} {
		if err := run(context.Background(), args); err == nil || !strings.Contains(err.Error(), "--remote flag is not supported") {
			t.Fatalf("explicit remote accepted: %v", err)
		}
	}
	t.Setenv("BBX_REMOTE", "")
	for _, args := range [][]string{{"mcp", "serve"}, {"call", "health.ping"}, {"screenshot", "main", "out.png"}} {
		if err := run(context.Background(), args); err == nil || err.Error() != "auto-update policy must be off or compatible" {
			t.Fatalf("preflight not reached for %v: %v", args, err)
		}
	}
	remotes := remoteConfig{Remotes: []remoteDestination{{ID: "selected", Host: "127.0.0.1", Port: 1, Token: strings.Repeat("a", 32)}}}
	if err := os.WriteFile(filepath.Join(home, "remotes.json"), value(remotes), 0600); err != nil {
		t.Fatal(err)
	}
	// Parsing fails before connecting, but only after remote preflight is skipped.
	if err := run(context.Background(), []string{"--remote", "selected", "eval"}); err == nil || !strings.HasPrefix(err.Error(), "Usage: eval") {
		t.Fatalf("remote command ran local preflight: %v", err)
	}
}

func TestCLIUpdateForwardingPrecedesStaticDispatch(t *testing.T) {
	home := cliUpdateTestHome(t)
	root := filepath.Join(home, "native-update")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "state.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"--version"}, {"--help"}, {"protocol", "describe"}} {
		if err := run(context.Background(), args); err == nil || !strings.Contains(err.Error(), "invalid native update state") {
			t.Fatalf("forwarding bypassed for %v: %v", args, err)
		}
	}
	if err := run(context.Background(), []string{"--self-test"}); err != nil {
		t.Fatalf("self-test did not bypass forwarding: %v", err)
	}
	if err := run(context.Background(), []string{"update", "invalid-action"}); err == nil || !strings.HasPrefix(err.Error(), "usage: bbx update") {
		t.Fatalf("update repair path blocked by forwarding: %v", err)
	}
}

func TestCLIForwardedExitStatus(t *testing.T) {
	if os.Getenv("BBX_TEST_FORWARDED_EXIT") == "1" {
		os.Exit(7)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestCLIForwardedExitStatus$")
	cmd.Env = append(os.Environ(), "BBX_TEST_FORWARDED_EXIT=1")
	err := cliForwardError(cmd.Run())
	var forwarded cliForwardedExit
	if !errors.As(err, &forwarded) || forwarded.ExitCode() != 7 {
		t.Fatalf("forwarded exit was not preserved: %v", err)
	}
	failure := errors.New("verification failed")
	if cliForwardError(failure) != failure || cliForwardError(nil) != nil {
		t.Fatal("ordinary forwarding results changed")
	}
}
