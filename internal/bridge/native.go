package bridge

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func startDaemon(c config) error {
	if err := os.MkdirAll(c.home, 0700); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(c.home, "daemon.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() { _ = log.Close() }()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(executable, "--bridge-daemon")
	cmd.Stdout, cmd.Stderr = log, log
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func bootstrap(c config) error {
	conn, err := c.dial()
	if err == nil {
		return conn.Close()
	}
	if !errors.Is(err, os.ErrNotExist) && !errors.Is(err, syscall.ECONNREFUSED) {
		return err
	}
	// A remote connection must never trigger a local daemon start.
	if c.remote {
		return err
	}
	if c.network == "tcp" && !strings.HasPrefix(c.address, "127.0.0.1:") && !strings.HasPrefix(c.address, "[::1]:") && !strings.HasPrefix(c.address, "localhost:") {
		return err
	}
	if err := startDaemon(c); err != nil {
		return err
	}
	for i := 0; i < 25; i++ {
		time.Sleep(100 * time.Millisecond)
		conn, err = c.dial()
		if err == nil {
			return conn.Close()
		}
	}
	return err
}

func isRefused(err error) bool { return errors.Is(err, syscall.ECONNREFUSED) }

func nativeToDaemon(message object) object {
	kind := message.text("type")
	if strings.HasPrefix(kind, "host.artifact.") {
		message["type"] = value("extension." + strings.TrimPrefix(kind, "host."))
		return message
	}
	if kind == "host.bridge_request" {
		return object{"type": value("agent.request"), "request": message["request"]}
	}
	switch kind {
	case "host.setup_status.request", "host.identity", "host.access_update", "host.activity",
		"host.window_action.request", "host.window_action.result", "host.journal.begin", "host.journal.append",
		"host.artifact.begin", "host.artifact.append", "host.artifact.finish", "host.artifact.abort":
		message["type"] = value("extension." + strings.TrimPrefix(kind, "host."))
		return message
	default:
		return object{"type": value("extension.response"), "response": value(message)}
	}
}

func daemonToNative(message object) object {
	kind := message.text("type")
	if kind == "extension.request" {
		return message.object("request")
	}
	if kind == "agent.response" {
		return object{"type": value("host.bridge_response"), "response": message["response"]}
	}
	switch kind {
	case "extension.owner_disconnected", "extension.window_access", "extension.window_action.command",
		"extension.journal.ack", "extension.window_action.response", "extension.setup_status.response", "extension.setup_status.error":
		message["type"] = value("host." + strings.TrimPrefix(kind, "extension."))
		return message
	}
	return nil
}

func nativeHost(ctx context.Context, c config, input io.Reader, output io.Writer) error {
	out := &wireWriter{out: output, native: true}
	if err := bootstrap(c); err != nil {
		_ = out.send(object{"type": value("host.bridge_response"), "response": value(failure("native_bootstrap", "NATIVE_HOST_UNAVAILABLE", err.Error()))})
		return err
	}
	conn, reader, err := register(c, "extension")
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	toDaemon := &wireWriter{out: conn}
	done := make(chan error, 2)
	go func() {
		for {
			message, err := readNative(input)
			if err != nil {
				done <- err
				return
			}
			if err := toDaemon.send(nativeToDaemon(message)); err != nil {
				done <- err
				return
			}
		}
	}()
	go func() {
		for {
			message, err := readLine(reader)
			if err != nil {
				done <- err
				return
			}
			if response := daemonToNative(message); response != nil {
				if err := out.send(response); err != nil {
					done <- err
					return
				}
			}
		}
	}()
	err = <-done
	if errors.Is(err, io.EOF) || ctx.Err() != nil {
		return nil
	}
	return err
}

func lineReader(input io.Reader) *bufio.Reader { return bufio.NewReader(input) }
