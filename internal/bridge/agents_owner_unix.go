//go:build !windows

package bridge

import (
	"os"
	"syscall"
)

// installOwnedByCurrentUser reports whether a rename-based rewrite keeps the
// file's owner. Under sudo the new file would belong to root instead.
func installOwnedByCurrentUser(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Geteuid()
}
