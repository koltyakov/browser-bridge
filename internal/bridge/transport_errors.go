package bridge

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"syscall"
)

// daemonUnavailableError is a failure to reach the daemon before anything was
// sent. Unlike a lost connection mid-request, it is always safe to retry.
type daemonUnavailableError struct{ cause error }

func (e *daemonUnavailableError) Error() string {
	return fmt.Sprintf("bridge daemon is not reachable: %v", e.cause)
}

func (e *daemonUnavailableError) Unwrap() error { return e.cause }

// wrapDialError marks a dial failure as daemon-unavailable.
func wrapDialError(err error) error {
	if err == nil {
		return nil
	}
	var unavailable *daemonUnavailableError
	if errors.As(err, &unavailable) {
		return err
	}
	return &daemonUnavailableError{cause: err}
}

// isDaemonUnavailable reports a pre-dispatch failure to reach the daemon.
func isDaemonUnavailable(err error) bool {
	var unavailable *daemonUnavailableError
	return errors.As(err, &unavailable)
}

// connectionLost reports that an established bridge connection went away,
// with the platform's own reset and broken-pipe errors.
func connectionLost(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNABORTED) ||
		errors.Is(err, syscall.EPIPE) || errors.Is(err, os.ErrClosed) || platformConnectionLost(err) ||
		strings.Contains(err.Error(), "Bridge socket closed")
}
