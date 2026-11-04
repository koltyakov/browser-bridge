package bridge

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestConnectionRefusedClassification(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want bool
	}{
		{"errno", syscall.ECONNREFUSED, true},
		{"wrapped dial", fmt.Errorf("bridge: %w", &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}), true},
		{"nil", nil, false},
		{"missing endpoint", os.ErrNotExist, false},
		{"permission denied", os.ErrPermission, false},
		{"deadline", context.DeadlineExceeded, false},
		{"timeout", syscall.ETIMEDOUT, false},
		{"reset", syscall.ECONNRESET, false},
		{"message only", errors.New(syscall.ECONNREFUSED.Error()), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := isRefused(test.err); got != test.want {
				t.Fatalf("isRefused(%v) = %t, want %t", test.err, got, test.want)
			}
		})
	}
}

func closedTCPAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return address
}

func TestConnectionRefusedFromClosedTCPEndpoint(t *testing.T) {
	c := config{network: "tcp", address: closedTCPAddress(t)}
	conn, err := c.dial()
	if conn != nil {
		_ = conn.Close()
	}
	if err == nil || !isRefused(err) {
		t.Fatalf("closed TCP endpoint was not recognized as refused: %v", err)
	}
}

func TestStopLocalDaemonWithClosedTCPEndpoint(t *testing.T) {
	home := filepath.Join(t.TempDir(), "must-not-be-created")
	c := config{home: home, network: "tcp", address: closedTCPAddress(t)}
	running, err := stopLocalDaemon(context.Background(), c)
	if err != nil || running {
		t.Fatalf("stopping an absent daemon should be a no-op: running=%t, err=%v", running, err)
	}
	if _, err := os.Stat(home); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stopping an absent daemon touched its home: %v", err)
	}
}
