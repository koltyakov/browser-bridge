package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Control registration is best effort. A sandbox that rejects listeners or
// registry files must still be able to use MCP over stdio.
func startMCPControl(c config, cancel context.CancelFunc) func() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return func() {}
	}
	id, token := uniqueID(), uniqueID()
	path := filepath.Join(c.home, "mcp-processes", id+".json")
	registration := object{"protocolVersion": value(1), "instanceId": value(id), "pid": value(os.Getpid()), "port": value(listener.Addr().(*net.TCPAddr).Port), "token": value(token)}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err == nil {
		err = os.WriteFile(path, value(registration), 0600)
	}
	if err != nil {
		listener.Close()
		return func() {}
	}
	var once sync.Once
	cleanup := func() { once.Do(func() { listener.Close(); _ = os.Remove(path) }) }
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(time.Second))
				line, err := bufio.NewReaderSize(conn, 4096).ReadSlice('\n')
				if err != nil || len(line) > 4096 {
					return
				}
				var request object
				ok := json.Unmarshal(line, &request) == nil && request.text("action") == "restart" && tokensEqual(request.text("token"), token)
				writer := wireWriter{out: conn}
				_ = writer.send(object{"ok": value(ok)})
				if ok {
					cleanup()
					cancel()
				}
			}()
		}
	}()
	return cleanup
}
