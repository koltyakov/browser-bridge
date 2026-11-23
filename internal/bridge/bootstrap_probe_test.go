package bridge

import (
	"bufio"
	"net"
	"strings"
	"testing"
)

func serveOnce(t *testing.T, reply string) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		_, _ = bufio.NewReader(conn).ReadString('\n')
		_, _ = conn.Write([]byte(reply))
	}()
	return listener.Addr().String()
}

func TestBootstrapRecognizesTheDaemonAndRejectsAForeignListener(t *testing.T) {
	daemon := serveOnce(t, "{\"type\":\"registration_failed\"}\n")
	if err := bootstrap(config{network: "tcp", address: daemon, home: t.TempDir()}); err != nil {
		t.Fatalf("daemon handshake rejected: %v", err)
	}
	foreign := serveOnce(t, "HTTP/1.1 400 Bad Request\r\n\r\n")
	err := bootstrap(config{network: "tcp", address: foreign, home: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "owned by another process") {
		t.Fatalf("foreign listener error = %v", err)
	}
}
