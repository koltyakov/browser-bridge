package bridge

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNpmDistributionSupportsGitHubRuntimeUpdates(t *testing.T) {
	t.Setenv("BBX_NPM_VERSION", version)
	t.Setenv("BBX_AUTO_UPDATE", "compatible")
	c := config{home: t.TempDir(), network: "invalid"}
	if forwarded, err := forwardNativeUpdate(context.Background(), c, []string{"--version"}); forwarded || err != nil {
		t.Fatalf("unmanaged npm bootstrap forwarded: %v", err)
	}
	if forwarded, err := prepareNativeClient(context.Background(), c, []string{"status"}); forwarded || err != nil {
		t.Fatalf("unavailable local transport prevented npm startup: %v", err)
	}
	status, err := nativeUpdateStatus(c)
	if err != nil || status.text("distribution") != "npm" || status.text("runningVersion") != version || !status.boolean("configured") || status.text("source") != "github" {
		t.Fatalf("invalid npm update status: %v %v", status, err)
	}
	manager, err := newNativeUpdater(c)
	if err != nil || !manager.GitHub {
		t.Fatal("npm updater required a separate feed", manager, err)
	}
	_, launcher := installLauncher(c, filepath.Join(c.home, "bbx"))
	if !strings.Contains(string(launcher), "BBX_NPM_VERSION") || !strings.Contains(string(launcher), version) {
		t.Fatal("browser launcher lost npm version pin")
	}
}

func TestNativeUpdateExactPinsSurviveDirectLaunches(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "bbx")
	if pinned, err := updateExecutablePinned(executable, "2.2.2"); err != nil || pinned {
		t.Fatal(pinned, err)
	}
	for _, test := range []struct {
		raw                   string
		wantPinned, wantError bool
	}{
		{`{"version":"2.2.2"}`, true, false},
		{`{"version":"2.2.1"}`, false, true},
		{`invalid`, false, true},
	} {
		if err := os.WriteFile(executable+".update-pin", []byte(test.raw), 0600); err != nil {
			t.Fatal(err)
		}
		pinned, err := updateExecutablePinned(executable, "2.2.2")
		if pinned != test.wantPinned || (err != nil) != test.wantError {
			t.Fatal(test.raw, pinned, err)
		}
	}
}
