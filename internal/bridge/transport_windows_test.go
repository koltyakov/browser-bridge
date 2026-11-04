package bridge

import (
	"fmt"
	"net"
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

func TestConnectionRefusedWinsockClassification(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want bool
	}{
		{"winsock errno", windows.WSAECONNREFUSED, true},
		{"wrapped connectex", fmt.Errorf("bridge: %w", &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connectex", windows.WSAECONNREFUSED)}), true},
		{"winsock timeout", windows.WSAETIMEDOUT, false},
		{"winsock reset", windows.WSAECONNRESET, false},
		{"access denied", windows.ERROR_ACCESS_DENIED, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := isRefused(test.err); got != test.want {
				t.Fatalf("isRefused(%v) = %t, want %t", test.err, got, test.want)
			}
		})
	}
}
