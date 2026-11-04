//go:build !windows

package bridge

import (
	"errors"
	"net"
	"syscall"
	"time"
)

func isRefused(err error) bool { return errors.Is(err, syscall.ECONNREFUSED) }

func dialTransport(network, address string, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout(network, address, timeout)
}
func (c config) listen() (net.Listener, error) { return net.Listen(c.network, c.bind) }
