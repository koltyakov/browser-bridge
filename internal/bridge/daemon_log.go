package bridge

import (
	"os"
	"path/filepath"
)

// maxDaemonLogBytes caps daemon.log. A crash-looping daemon appends on every
// start, so the log is rotated to daemon.log.1 when it passes the cap.
const maxDaemonLogBytes = 5 << 20

// openDaemonLog opens daemon.log for appending, rotating it first when it is
// over the size cap. One previous generation is kept.
func openDaemonLog(home string) (*os.File, error) {
	path := filepath.Join(home, "daemon.log")
	if info, err := os.Stat(path); err == nil && info.Size() > maxDaemonLogBytes {
		_ = os.Rename(path, path+".1")
	}
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}
