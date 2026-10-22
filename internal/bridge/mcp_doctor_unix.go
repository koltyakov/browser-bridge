//go:build !windows

package bridge

import (
	"errors"
	"golang.org/x/sys/unix"
)

func mcpDoctorUnwritable(path string) bool {
	err := unix.Access(path, unix.W_OK)
	return err != nil && !errors.Is(err, unix.ENOENT)
}
