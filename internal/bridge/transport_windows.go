package bridge

import (
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

func dialTransport(network, address string, timeout time.Duration) (net.Conn, error) {
	if network == "pipe" {
		return winio.DialPipe(address, &timeout)
	}
	return net.DialTimeout(network, address, timeout)
}
func (c config) listen() (net.Listener, error) {
	if c.network == "pipe" {
		return winio.ListenPipe(c.bind, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;SY)(A;;GA;;;OW)", InputBufferSize: 65536, OutputBufferSize: 65536})
	}
	return net.Listen(c.network, c.bind)
}
