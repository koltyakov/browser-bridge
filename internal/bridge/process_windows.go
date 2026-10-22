package bridge

import (
	"os"
	"os/exec"
	"syscall"
)

func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200 | 0x08000000, HideWindow: true}
}

func terminateProcess(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	defer p.Release()
	return p.Kill()
}
func processRunning(pid int) bool {
	handle, err := syscall.OpenProcess(0x1000, false, uint32(pid))
	if err != nil {
		return err == syscall.ERROR_ACCESS_DENIED
	}
	defer syscall.CloseHandle(handle)
	var code uint32
	if syscall.GetExitCodeProcess(handle, &code) != nil {
		return true
	}
	return code == 259
}
