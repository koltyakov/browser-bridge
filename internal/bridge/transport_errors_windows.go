//go:build windows

package bridge

import (
	"errors"

	"golang.org/x/sys/windows"
)

// On Windows, Go's syscall.ECONNRESET is not the Winsock code, and named
// pipes report their own errors, so a restarted daemon needs these too.
func platformConnectionLost(err error) bool {
	for _, code := range []windows.Errno{
		windows.WSAECONNRESET,
		windows.WSAECONNABORTED,
		windows.WSAECONNREFUSED,
		windows.WSAENOTCONN,
		windows.ERROR_BROKEN_PIPE,
		windows.ERROR_PIPE_NOT_CONNECTED,
		windows.ERROR_NO_DATA,
		windows.ERROR_NETNAME_DELETED,
	} {
		if errors.Is(err, code) {
			return true
		}
	}
	return false
}
