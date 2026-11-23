package bridge

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func startDaemon(c config) error {
	if err := os.MkdirAll(c.home, 0700); err != nil {
		return err
	}
	log, err := openDaemonLog(c.home)
	if err != nil {
		return err
	}
	defer func() { _ = log.Close() }()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	cmd, err := daemonCommand(c, executable)
	if err != nil {
		return err
	}
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func daemonCommand(c config, executable string) (*exec.Cmd, error) {
	cmd := exec.Command(executable, "--bridge-daemon")
	// Windows keeps a process's working directory locked. Never retain npm's
	// staging directory after postinstall, or package managers cannot move it.
	// Relative homes retain the caller's cwd and existing transport identity.
	if filepath.IsAbs(c.home) {
		cmd.Dir = c.home
		cmd.Env = os.Environ()
		for i, entry := range cmd.Env {
			key, path, _ := strings.Cut(entry, "=")
			if !strings.EqualFold(key, "BBX_AUTH_TOKEN_FILE") || path == "" || filepath.IsAbs(path) {
				continue
			}
			// Preserve token paths relative to the caller when changing cwd.
			absolute, err := filepath.Abs(path)
			if err != nil {
				return nil, err
			}
			cmd.Env[i] = key + "=" + absolute
		}
	}
	detach(cmd)
	return cmd, nil
}

func bootstrap(c config) error {
	conn, err := c.dial()
	if err == nil {
		if c.network == "tcp" && !c.remote {
			// On Windows the default endpoint is a fixed TCP port. Any program
			// listening there would otherwise pass for the daemon.
			return probeBridgeListener(conn, c.address)
		}
		return conn.Close()
	}
	if !errors.Is(err, os.ErrNotExist) && !isRefused(err) {
		return err
	}
	// A remote connection must never trigger a local daemon start.
	if c.remote {
		return err
	}
	if c.network == "tcp" && !strings.HasPrefix(c.address, "127.0.0.1:") && !strings.HasPrefix(c.address, "[::1]:") && !strings.HasPrefix(c.address, "localhost:") {
		return err
	}
	// Every extension reconnect runs bootstrap. A daemon that dies at startup
	// would be respawned on each one; back off once spawns form a loop.
	now := time.Now()
	starts := readDaemonStarts(c.home)
	if wait := daemonRestartBackoff(starts, now); wait > 0 {
		count, _ := daemonStartsInWindow(starts, now)
		return daemonRestartLoopError(c.home, count, wait)
	}
	recordDaemonStart(c.home, now)
	if err := startDaemon(c); err != nil {
		return err
	}
	return waitForDaemon(c, 2500*time.Millisecond)
}

// probeBridgeListener confirms that a TCP listener speaks the bridge
// handshake. The daemon answers any registration, valid or not, with a
// registered or registration_failed line; another program does not.
func probeBridgeListener(conn net.Conn, address string) error {
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	writer := wireWriter{out: conn}
	if err := writer.send(object{"type": value("register"), "role": value("probe")}); err != nil {
		return fmt.Errorf("bridge endpoint %s did not accept a handshake: %w", address, err)
	}
	reply, err := readLine(bufio.NewReader(conn))
	if err == nil {
		switch reply.text("type") {
		case "registered", "registration_failed":
			return nil
		}
	}
	return fmt.Errorf("port %s is owned by another process, not the Browser Bridge daemon. Stop that program, set BBX_TCP_PORT to a free port, or set BROWSER_BRIDGE_HOME to use a per-user named pipe", address)
}

// waitForDaemon polls a just-spawned daemon quickly at first, then backs off,
// so a daemon that is ready in milliseconds is not held to a 100 ms tick.
func waitForDaemon(c config, budget time.Duration) error {
	deadline := time.Now().Add(budget)
	delay := 5 * time.Millisecond
	var err error
	for {
		var conn net.Conn
		conn, err = c.dial()
		if err == nil {
			return conn.Close()
		}
		if time.Now().Add(delay).After(deadline) {
			return err
		}
		time.Sleep(delay)
		delay = min(delay*2, 100*time.Millisecond)
	}
}

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
		"host.update_ready", "host.update_cancel",
		"host.mutation_ready", "host.visual_baseline_invalidated",
		"host.window_action.request", "host.window_action.result", "host.journal.begin", "host.journal.append",
		"host.artifact.begin", "host.artifact.append", "host.artifact.finish", "host.artifact.abort":
		message["type"] = value("extension." + strings.TrimPrefix(kind, "host."))
		return message
	default:
		return object{"type": value("extension.response"), "response": rawObject(message)}
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
	case "extension.request_cancelled", "extension.artifact.ack", "extension.owner_disconnected", "extension.window_access", "extension.window_action.command",
		"extension.update_check", "extension.update_apply",
		"extension.mutation_granted",
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
		_ = out.send(object{"type": value("host.bridge_response"), "response": value(failure("native_register", "NATIVE_HOST_UNAVAILABLE", "The native host could not register with the bridge daemon: "+err.Error()))})
		return err
	}
	defer func() { _ = conn.Close() }()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	toDaemon := &wireWriter{out: conn, lineLimit: maxWireLineBytes}
	done := make(chan error, 2)
	updateCtx, cancelUpdate := context.WithCancel(ctx)
	defer cancelUpdate()
	go func() {
		updateStarted := false
		for {
			message, err := readNative(input)
			if errors.Is(err, errNativeFrameTooLarge) {
				// The frame was skipped whole; later frames are intact.
				continue
			}
			if err != nil {
				done <- err
				return
			}
			isIdentity := message.text("type") == "host.identity" && message.text("extensionVersion") != ""
			if _, err := toDaemon.sendPayloadContext(context.Background(), rawObject(nativeToDaemon(message))); err != nil {
				if errors.Is(err, errMessageTooLarge) {
					// Fail this one message where its sender is waiting; keep relaying.
					relayOversizedFromExtension(message, toDaemon, out)
					continue
				}
				done <- err
				return
			}
			if !updateStarted && isIdentity {
				updateStarted = true
				go checkExtensionNativeUpdate(updateCtx, c, message, updateCompatibleNative, restartUpdatedNative)
			}
		}
	}()
	go func() {
		for {
			message, err := readWireLine(reader)
			var oversized *oversizedLineError
			if errors.As(err, &oversized) {
				if skipErr := skipOversizedLine(reader, err); skipErr != nil {
					done <- skipErr
					return
				}
				continue
			}
			if err != nil {
				done <- err
				return
			}
			if response := daemonToNative(message); response != nil {
				if _, err := out.sendPayloadContext(context.Background(), rawObject(response)); err != nil {
					if errors.Is(err, errMessageTooLarge) {
						relayOversizedFromDaemon(message, toDaemon)
						continue
					}
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
	// Tell the extension why the host is going away before Chrome sees only a
	// closed pipe; the extension shows it and reconnects.
	_ = out.send(object{"type": value("host.bridge_response"), "response": value(failure("native_relay", "NATIVE_HOST_UNAVAILABLE", "The native host stopped relaying: "+err.Error()))})
	return err
}

// relayOversizedFromExtension answers an extension message whose daemon
// envelope exceeds the line limit: a result goes back to the waiting agent as
// RESULT_TOO_LARGE, and an extension-originated request is failed locally.
func relayOversizedFromExtension(message object, toDaemon, toExtension *wireWriter) {
	const text = "The browser result exceeds the 1 MiB transport limit. Request less data: a smaller maxNodes or textBudget, a narrower selector, or a screenshot artifact."
	switch kind := message.text("type"); {
	case kind == "host.bridge_request":
		id := message.object("request").text("id")
		_ = toExtension.send(object{"type": value("host.bridge_response"), "response": value(failure(id, "RESULT_TOO_LARGE", text))})
	case kind == "" || !strings.HasPrefix(kind, "host."):
		if id := message.text("id"); id != "" {
			response := failure(id, "RESULT_TOO_LARGE", text)
			if meta := message["meta"]; meta != nil {
				response["meta"] = meta
			}
			_ = toDaemon.send(object{"type": value("extension.response"), "response": rawObject(response)})
		}
	}
}

// relayOversizedFromDaemon fails a daemon request that Chrome would reject as
// too large for native messaging, instead of dropping the relay.
func relayOversizedFromDaemon(message object, toDaemon *wireWriter) {
	if message.text("type") != "extension.request" {
		return
	}
	id := message.object("request").text("id")
	if id == "" {
		return
	}
	_ = toDaemon.send(object{"type": value("extension.response"), "response": rawObject(failure(id, "RESULT_TOO_LARGE", "The request exceeds the 1 MiB native messaging limit and was not sent to the browser."))})
}

func lineReader(input io.Reader) *bufio.Reader { return bufio.NewReader(input) }
