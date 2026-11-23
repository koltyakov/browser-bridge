package bridge

import (
	"errors"
	"testing"
)

func TestDaemonLockAdmitsOneDaemonPerHome(t *testing.T) {
	home := t.TempDir()
	release, err := acquireDaemonLock(home)
	if err != nil {
		t.Fatalf("first lock: %v", err)
	}
	if _, err := acquireDaemonLock(home); !errors.Is(err, errDaemonRunning) {
		t.Fatalf("second lock = %v, want errDaemonRunning", err)
	}
	release()
	again, err := acquireDaemonLock(home)
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	again()
}
