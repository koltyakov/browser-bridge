package main

import (
	"errors"
	"os"
	"os/exec"
)

func ownProcess(_ *exec.Cmd) {}

func stopOwnedProcess(cmd *exec.Cmd) error {
	err := cmd.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		err = nil
	}
	_ = cmd.Wait()
	return err
}
