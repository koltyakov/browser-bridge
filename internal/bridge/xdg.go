package bridge

import "path/filepath"

// The XDG specification requires ignoring relative environment paths. Resolving
// them against the CLI/GUI working directory would select different installs.
func xdgDirectory(env func(string) string, key, fallback string) string {
	if directory := env(key); filepath.IsAbs(directory) {
		return directory
	}
	return fallback
}
