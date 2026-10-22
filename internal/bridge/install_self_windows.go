package bridge

import (
	"fmt"
	"os"
	"path/filepath"
)

func installSelfReplace(source, destination string) error {
	err := os.Rename(source, destination)
	if err == nil {
		return nil
	}
	// Windows cannot replace a running executable in place. Move that file
	// aside, publish the staged binary, and keep the old image until it exits.
	info, statErr := os.Lstat(destination)
	if statErr != nil || !info.Mode().IsRegular() {
		return err
	}
	backup := filepath.Join(filepath.Dir(destination), ".bbx-replaced-"+uniqueID()+filepath.Ext(destination))
	if moveErr := os.Rename(destination, backup); moveErr != nil {
		return err
	}
	if err := os.Rename(source, destination); err != nil {
		if restoreErr := os.Rename(backup, destination); restoreErr != nil {
			return fmt.Errorf("install failed: %w; restore %s: %v", err, backup, restoreErr)
		}
		return err
	}
	_ = os.Remove(backup)
	return nil
}
