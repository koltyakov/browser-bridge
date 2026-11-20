package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Identity arrives on Chrome's native messaging pipe after every extension
// reconnect, including an extension update. It needs no enabled page or agent.
func checkExtensionNativeUpdate(ctx context.Context, c config, identity object, update compatibleNativeUpdate, restart func(config, string) error) {
	var supported []string
	if err := json.Unmarshal(identity["supported_versions"], &supported); err != nil || len(supported) == 0 {
		return
	}
	result, err := update(ctx, c, identity.text("extensionVersion"), supported)
	if err == nil && result.boolean("updated") {
		err = restart(c, result.text("executable"))
	}
	if err != nil {
		// stdout is reserved for Chrome's framed native-messaging protocol.
		fmt.Fprintln(os.Stderr, "Automatic Browser Bridge native update failed:", err)
	}
}

// A running daemon checks even if no browser reconnects or agent sends a command.
// The manager shares its daily throttle and installation lock with native hosts.
func periodicNativeUpdates(ctx context.Context, c config, ticks <-chan time.Time, update compatibleNativeUpdate, restart func(config, string) error) {
	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-ticks:
			if !ok {
				return
			}
			result, err := update(ctx, c, "", nil)
			if err == nil && result.boolean("updated") {
				err = restart(c, result.text("executable"))
			}
			if err != nil && ctx.Err() == nil {
				fmt.Fprintln(os.Stderr, "Periodic Browser Bridge native update failed:", err)
			}
		}
	}
}

// The restart worker must outlive this native host. Restarting the daemon closes
// its socket, causing Chrome to reconnect through the verified active selection.
// Existing MCP control endpoints ask their owning agents to relaunch as well.
func restartUpdatedNative(c config, executable string) error {
	if executable == "" {
		return fmt.Errorf("updated native release has no executable")
	}
	log, err := os.OpenFile(filepath.Join(c.home, "daemon.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() { _ = log.Close() }()
	command := exec.Command(executable, "restart")
	command.Env = os.Environ()
	command.Dir = c.home
	command.Stdout, command.Stderr = log, log
	detach(command)
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
