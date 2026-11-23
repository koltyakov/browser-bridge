package bridge

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDaemonLogRotatesPastItsCap(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "daemon.log")
	if err := os.WriteFile(path, make([]byte, maxDaemonLogBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	log, err := openDaemonLog(home)
	if err != nil {
		t.Fatal(err)
	}
	_ = log.Close()
	if info, err := os.Stat(path); err != nil || info.Size() != 0 {
		t.Fatalf("daemon.log not rotated: %v %v", info, err)
	}
	if info, err := os.Stat(path + ".1"); err != nil || info.Size() != maxDaemonLogBytes+1 {
		t.Fatalf("previous log not kept: %v %v", info, err)
	}
}
