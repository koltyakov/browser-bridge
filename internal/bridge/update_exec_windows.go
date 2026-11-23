//go:build windows

package bridge

import (
	"context"
	"os"
	"os/exec"
)

// runNativePayload runs the active native release as a child: Windows has no
// exec, and the child must keep this console's standard streams.
func runNativePayload(ctx context.Context, path string, args []string) error {
	command := exec.CommandContext(ctx, path, args...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	return command.Run()
}
