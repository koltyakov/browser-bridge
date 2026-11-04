package bridge

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

func TestNativeUpdateUsesAuthenticatedHealthCompatibility(t *testing.T) {
	for _, test := range []struct {
		name      string
		remote    bool
		health    object
		wantCalls int
	}{
		{"disconnected", false, object{"extensionVersion": value("9.0.0")}, 0},
		{"remote", true, object{"extensionConnected": value(true), "extensionVersion": value("1.14.3"), "supported_versions": value([]string{"1.14"})}, 0},
		{"missing protocols", false, object{"extensionConnected": value(true), "extensionVersion": value("1.14.3")}, 0},
		{"extension protocols", false, object{"extensionConnected": value(true), "extensionVersion": value("1.14.3"), "extension_supported_versions": value([]string{"1.14"}), "supported_versions": value([]string{"9.0"})}, 1},
		{"legacy health", false, object{"extensionConnected": value(true), "extensionVersion": value("1.14.3"), "supported_versions": value([]string{"1.14"})}, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			_, err := checkNativeClientUpdate(context.Background(), config{remote: test.remote}, test.health, func(_ context.Context, _ config, version string, protocols []string) (object, error) {
				calls++
				if version != "1.14.3" || len(protocols) != 1 || protocols[0] != "1.14" {
					t.Fatalf("wrong compatibility: %s %v", version, protocols)
				}
				return object{"updated": value(false)}, nil
			})
			if err != nil || calls != test.wantCalls {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestNativeUpdateOffAndRemoteDoNotConnect(t *testing.T) {
	t.Setenv("BBX_AUTO_UPDATE", "off")
	for _, c := range []config{{home: t.TempDir(), network: "invalid"}, {home: t.TempDir(), network: "invalid", remote: true}} {
		forwarded, err := prepareNativeClient(context.Background(), c, []string{"status"})
		if err != nil || forwarded {
			t.Fatalf("disabled update attempted transport: %v", err)
		}
	}
}

func TestNativeUpdatePreparationDoesNotBoundCallerLifetime(t *testing.T) {
	t.Setenv("BBX_AUTO_UPDATE", "compatible")
	t.Setenv("BBX_NPM_VERSION", "")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	c := config{home: t.TempDir(), network: "tcp", address: listener.Addr().String(), token: strings.Repeat("a", 43)}
	serverDone := make(chan error, 1)
	go func() {
		serverDone <- func() error {
			conn, err := listener.Accept()
			if err != nil {
				return err
			}
			defer func() { _ = conn.Close() }()
			// No real daemon is running: preparation's stop must be a no-op.
			_ = listener.Close()
			_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
			reader := bufio.NewReader(conn)
			registration, err := readLine(reader)
			if err != nil {
				return err
			}
			if registration.text("role") != "agent" || registration.text("authToken") != c.token {
				return errors.New("unexpected agent registration")
			}
			writer := wireWriter{out: conn}
			if err := writer.send(object{"type": value("registered"), "role": value("agent")}); err != nil {
				return err
			}
			message, err := readLine(reader)
			if err != nil {
				return err
			}
			request := message.object("request")
			if request.text("method") != "health.ping" {
				return fmt.Errorf("unexpected preparation request %q", request.text("method"))
			}
			return writer.send(object{"type": value("agent.response"), "response": value(success(request.text("id"), object{
				"extensionConnected": value(true), "extensionVersion": value("2.1.0"), "supported_versions": value([]string{"2.0"}),
			}))})
		}()
	}()
	caller, cancel := context.WithCancel(context.Background())
	defer cancel()
	var preparation context.Context
	updated, err := prepareNativeClientUpdate(caller, c, func(ctx context.Context, _ config, _ string, _ []string) (object, error) {
		preparation = ctx
		deadline, bounded := ctx.Deadline()
		if !bounded || time.Until(deadline) <= 0 || time.Until(deadline) > 3*time.Minute {
			t.Fatal("update preparation must retain its three-minute limit")
		}
		return object{"updated": value(true)}, nil
	})
	if err != nil || !updated {
		t.Fatalf("preparation did not complete: updated=%t, err=%v", updated, err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	if preparation == nil || !errors.Is(preparation.Err(), context.Canceled) {
		t.Fatal("preparation context was not released before command forwarding")
	}
	if _, bounded := caller.Deadline(); bounded || caller.Err() != nil {
		t.Fatal("preparation limited or canceled the caller used for command forwarding")
	}
}
