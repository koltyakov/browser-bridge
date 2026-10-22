package bridge

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNpmDistributionKeepsItsPinnedRuntime(t *testing.T) {
	t.Setenv("BBX_NPM_VERSION", version)
	t.Setenv("BBX_AUTO_UPDATE", "compatible")
	c := config{home: t.TempDir(), network: "invalid"}
	if err := os.MkdirAll(filepath.Join(c.home, "native-update"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(c.home, "native-update", "state.json"), []byte("invalid native updater state"), 0600); err != nil {
		t.Fatal(err)
	}
	if forwarded, err := forwardNativeUpdate(context.Background(), c, []string{"--version"}); forwarded || err != nil {
		t.Fatalf("npm runtime read native update selection: %v", err)
	}
	if forwarded, err := prepareNativeClient(context.Background(), c, []string{"status"}); forwarded || err != nil {
		t.Fatalf("npm runtime attempted native self-update: %v", err)
	}
	status, err := nativeUpdateStatus(c)
	if err != nil || status.text("distribution") != "npm" || status.text("runningVersion") != version {
		t.Fatalf("invalid npm update status: %v %v", status, err)
	}
	if handled, err := handleUpdateCommand(context.Background(), c, []string{"update", "apply"}); !handled || err == nil || !strings.Contains(err.Error(), "npm install") {
		t.Fatal("native update accepted for npm-managed runtime")
	}
	_, launcher := installLauncher(c, filepath.Join(c.home, "bbx"))
	if !strings.Contains(string(launcher), "BBX_NPM_VERSION") || !strings.Contains(string(launcher), version) {
		t.Fatal("browser launcher lost npm version pin")
	}
}
