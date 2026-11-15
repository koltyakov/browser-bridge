//go:build !windows

package main

import (
	"errors"
	"os/exec"
	"syscall"
)

func ownProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func stopOwnedProcess(cmd *exec.Cmd) error {
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		err = nil
	}
	_ = cmd.Wait()
	return err
}
