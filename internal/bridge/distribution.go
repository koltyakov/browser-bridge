package bridge

import (
	"errors"
	"os"
	"path/filepath"
)

// npm identifies the bootstrap release independently of its package version.
func npmManagedRuntime() bool {
	return os.Getenv("BBX_NPM_VERSION") == version
}

// An exact npm selector gets its own cache directory and pin beside the binary.
// Absolute MCP commands retain the pin without depending on launcher environment.
func updateRuntimePinned() (bool, error) {
	executable, err := os.Executable()
	if err != nil {
		return false, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return false, err
	}
	return updateExecutablePinned(executable, version)
}

func updateExecutablePinned(executable, runningVersion string) (bool, error) {
	raw, err := updateReadRegular(executable+".update-pin", 128)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	pin, err := decodeObject(raw)
	if err != nil || pin.text("version") != runningVersion {
		return false, errors.New("invalid native update version pin")
	}
	return true, nil
}
