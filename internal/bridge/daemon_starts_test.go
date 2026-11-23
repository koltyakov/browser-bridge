package bridge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDaemonRestartBackoffStartsAtTheLoopThreshold(t *testing.T) {
	now := time.UnixMilli(1_000_000_000)
	at := func(ago time.Duration) int64 { return now.Add(-ago).UnixMilli() }
	if wait := daemonRestartBackoff([]int64{at(30 * time.Second), at(time.Second)}, now); wait != 0 {
		t.Fatalf("two starts back off %v, want 0", wait)
	}
	loop := []int64{at(40 * time.Second), at(20 * time.Second), at(time.Second)}
	if wait := daemonRestartBackoff(loop, now); wait != 4*time.Second {
		t.Fatalf("three starts wait %v, want 4s (5s after the last start)", wait)
	}
	if wait := daemonRestartBackoff(loop, now.Add(10*time.Second)); wait != 0 {
		t.Fatalf("back-off still active after it elapsed: %v", wait)
	}
	old := []int64{at(5 * time.Minute), at(4 * time.Minute), at(3 * time.Minute)}
	if wait := daemonRestartBackoff(old, now); wait != 0 {
		t.Fatalf("starts outside the window back off %v", wait)
	}
}

func TestRecordDaemonStartKeepsBoundedHistory(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	for i := range 20 {
		recordDaemonStart(home, now.Add(time.Duration(i)*time.Second))
	}
	starts := readDaemonStarts(home)
	if len(starts) != daemonStartHistoryLimit {
		t.Fatalf("history length %d, want %d", len(starts), daemonStartHistoryLimit)
	}
}

func TestBootstrapSkipsSpawnDuringRestartLoopAndNamesTheCause(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	for _, ago := range []time.Duration{20 * time.Second, 10 * time.Second, time.Second} {
		recordDaemonStart(home, now.Add(-ago))
	}
	if err := os.WriteFile(filepath.Join(home, "daemon.log"), []byte("starting\nopen daemon.extension.auth: permission denied\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Socket paths are limited to about 100 bytes; TempDir paths can exceed it.
	socketDir, err := os.MkdirTemp("", "bbx")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketDir) })
	c := config{home: home, network: "unix", address: filepath.Join(socketDir, "s.sock")}
	err = bootstrap(c)
	if err == nil || !strings.Contains(err.Error(), "restarted 3 times") || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("bootstrap error = %v", err)
	}
	if got := len(readDaemonStarts(home)); got != 3 {
		t.Fatalf("a skipped spawn was recorded: %d starts", got)
	}
}
