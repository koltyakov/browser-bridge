//go:build !windows

package bridge

import (
	"context"
	"errors"
	"syscall"
)

func updateAcquireLock(ctx context.Context, root string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	file, err := updateOpenLock(root)
	if err != nil {
		return nil, err
	}
	for {
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN); _ = file.Close() }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			file.Close()
			return nil, err
		}
		if err := updateWaitForLock(ctx); err != nil {
			file.Close()
			return nil, err
		}
	}
}
