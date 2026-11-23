package bridge

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestVerifiedPayloadCacheMissesOnAnyChange(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "bbx")
	if err := os.WriteFile(path, []byte("payload"), 0o755); err != nil {
		t.Fatal(err)
	}
	record := updateInstalled{Size: 7, SHA256: "abc"}
	if updateVerifiedCacheHit(root, path, record) {
		t.Fatal("hit before any verification")
	}
	updateRememberVerified(root, path, record)
	if !updateVerifiedCacheHit(root, path, record) {
		t.Fatal("miss right after verification")
	}
	if updateVerifiedCacheHit(root, path, updateInstalled{Size: 7, SHA256: "other"}) {
		t.Fatal("hit for a different release digest")
	}
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
	if updateVerifiedCacheHit(root, path, record) {
		t.Fatal("hit after the file was modified")
	}
}
