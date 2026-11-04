package bridge

import (
	"bufio"
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestClientLocalRegistrationNodeCompatibility(t *testing.T) {
	t.Setenv("BBX_AUTH_TOKEN", "")
	for _, present := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy missing credential", true: "existing credential"}[present], func(t *testing.T) {
			root, err := os.MkdirTemp("", "bbx-auth-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(root) })
			c := config{home: root, network: "unix", address: filepath.Join(root, "s"), agentToken: filepath.Join(root, "daemon.auth")}
			if runtime.GOOS == "windows" {
				c.network, c.address = "pipe", windowsPipeAddress(root)
			}
			c.bind = c.address
			token := ""
			if present {
				token = strings.Repeat("a", 43)
				if err := os.WriteFile(c.agentToken, []byte(token), 0600); err != nil {
					t.Fatal(err)
				}
			}
			listener, err := c.listen()
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = listener.Close() }()
			registered := make(chan object, 1)
			serverError := make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					serverError <- err
					return
				}
				defer func() { _ = conn.Close() }()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				message, err := readLine(bufio.NewReader(conn))
				if err == nil {
					registered <- message
					writer := wireWriter{out: conn}
					err = writer.send(object{"type": value("registered"), "role": value("agent")})
				}
				serverError <- err
			}()
			conn, _, _, err := registerConnection(c, "agent")
			if err != nil {
				t.Fatal(err)
			}
			_ = conn.Close()
			if err := <-serverError; err != nil {
				t.Fatal(err)
			}
			if message := <-registered; message.text("authToken") != token {
				t.Fatal("client did not preserve local credential semantics")
			}
		})
	}
}

func TestClientCanceledQueuedMutationDoesNotDispatchOrCloseConnection(t *testing.T) {
	local, remote := net.Pipe()
	t.Cleanup(func() { _ = remote.Close() })
	cl := &client{conn: local, writer: wireWriter{out: local}, pending: make(map[string]chan callResult)}
	t.Cleanup(cl.close)
	go cl.read(bufio.NewReader(local))
	// Hold the writer so cancellation must win before any bytes are sent.
	cl.writer.once.Do(func() { cl.writer.turn = make(chan struct{}, 1) })
	cl.writer.turn <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() {
		_, err := cl.request(ctx, newRequest("input.click", nil, nil, 1))
		finished <- err
	}()
	deadline := time.Now().Add(time.Second)
	for {
		cl.mu.Lock()
		pending := len(cl.pending)
		cl.mu.Unlock()
		if pending == 1 {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("request was not admitted")
		}
		runtime.Gosched()
	}
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled request: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("queued cancellation waited for the previous writer")
	}
	<-cl.writer.turn
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	server := make(chan error, 1)
	go func() {
		message, err := readLine(bufio.NewReader(remote))
		if err == nil {
			request := message.object("request")
			if request.text("method") != "health.ping" {
				err = errors.New("canceled mutation was dispatched")
			} else {
				writer := wireWriter{out: remote}
				err = writer.send(object{"type": value("agent.response"), "response": value(success(request.text("id"), object{}))})
			}
		}
		server <- err
	}()
	response, err := cl.request(ctx, newRequest("health.ping", nil, nil, 0))
	if err != nil || !response.boolean("ok") {
		t.Fatalf("healthy connection lost after queued cancellation: %v", err)
	}
	if err := <-server; err != nil {
		t.Fatal(err)
	}
}

func TestClientCancellationInterruptsBlockedWrite(t *testing.T) {
	local, remote := net.Pipe()
	t.Cleanup(func() { _ = remote.Close() })
	cl := &client{conn: local, writer: wireWriter{out: local}, pending: make(map[string]chan callResult)}
	t.Cleanup(cl.close)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		_, err := cl.request(ctx, newRequest("input.click", nil, nil, 1))
		finished <- err
	}()
	select {
	case err := <-finished:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("blocked write ignored its context: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("write retained the fixed five-second timeout")
	}
}
