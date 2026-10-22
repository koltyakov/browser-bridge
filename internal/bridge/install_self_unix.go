//go:build !windows

package bridge

import "os"

func installSelfReplace(source, destination string) error {
	return os.Rename(source, destination)
}
