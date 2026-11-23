//go:build !windows

package bridge

import (
	"context"
	"os"
	"syscall"
)

// runNativePayload replaces this process with the active native release, so
// the command runs once instead of as a child of a second process.
func runNativePayload(_ context.Context, path string, args []string) error {
	return syscall.Exec(path, append([]string{path}, args...), os.Environ())
}
