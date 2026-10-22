package bridge

import "os"

// npm pins the executable to its package version. The wrapper and generated
// browser launcher carry this marker into native host and daemon subprocesses.
func npmManagedRuntime() bool {
	return os.Getenv("BBX_NPM_VERSION") == version
}
