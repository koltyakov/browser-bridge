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

// reapDeadMCPRegistrations removes registrations whose process has exited.
// A live or reused PID is left for restartMCPProcesses, which also dials.
func reapDeadMCPRegistrations(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		registration, err := decodeObject(data)
		if err != nil {
			continue
		}
		if pid := registration.number("pid"); pid > 0 && pid != int64(os.Getpid()) && !processRunning(int(pid)) {
			_ = os.Remove(path)
		}
	}
}

// Control registration is best effort. A sandbox that rejects listeners or
// registry files must still be able to use MCP over stdio.
func startMCPControl(c config, cancel context.CancelFunc) func() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return func() {}
	}
	id, token := uniqueID(), uniqueID()
	path := filepath.Join(c.home, "mcp-processes", id+".json")
	// A SIGKILLed MCP process never removes its file. Clear those first so
	// the directory does not grow and restarts do not dial dead endpoints.
	reapDeadMCPRegistrations(filepath.Dir(path))
	registration := object{"protocolVersion": value(1), "instanceId": value(id), "pid": value(os.Getpid()), "port": value(listener.Addr().(*net.TCPAddr).Port), "token": value(token)}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err == nil {
		err = os.WriteFile(path, value(registration), 0600)
	}
	if err != nil {
		_ = listener.Close()
		return func() {}
	}
	var once sync.Once
	cleanup := func() { once.Do(func() { _ = listener.Close(); _ = os.Remove(path) }) }
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
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
