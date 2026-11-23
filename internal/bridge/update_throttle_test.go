package bridge

import (
	"path/filepath"
	"testing"
	"time"
)

func TestUpdateCheckedRecentlyReadsStateWithoutCreatingIt(t *testing.T) {
	home := t.TempDir()
	c := config{home: home}
	now := time.Now()
	if updateCheckedRecently(c, now) {
		t.Fatal("a home without update state reported a recent check")
	}
	if _, err := filepath.Glob(filepath.Join(home, "native-update", "*")); err != nil {
		t.Fatal(err)
	}
	root, err := updatePrepareRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	state := updateEmptyState()
	state.LastCheck = now.Add(-time.Hour)
	state.LastExtensionVersion = "2.4.0"
	if err := updateSaveState(root, state); err != nil {
		t.Fatal(err)
	}
	if !updateCheckedRecently(c, now) {
		t.Fatal("an hour-old check was not recent")
	}
	if updateCheckedRecently(c, now.Add(24*time.Hour)) {
		t.Fatal("a day-old check still counted as recent")
	}
	if updateNewerExtension(c, "2.4.0") || !updateNewerExtension(c, "2.5.0") {
		t.Fatal("newer-extension detection")
	}
}

func TestAutomaticUpdateSkipsInsteadOfWaitingForAHeldLock(t *testing.T) {
	root := t.TempDir()
	release, held, err := tryLockFile(filepath.Join(root, "update.lock"))
	if err != nil || held {
		t.Fatalf("lock: held=%v err=%v", held, err)
	}
	defer release()
	manager := &updateManager{Root: root, Automatic: true, GitHub: true, Version: "2.4.0"}
	started := time.Now()
	result, err := manager.run(t.Context(), "apply", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.text("reason") != "update_in_progress" || time.Since(started) > time.Second {
		t.Fatalf("automatic run waited or did not skip: %v after %v", result, time.Since(started))
	}
}
