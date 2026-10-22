//go:build !windows

package bridge

import (
	"errors"
	"os/exec"
	"syscall"
)

func detach(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

func terminateProcess(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }
func processRunning(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
