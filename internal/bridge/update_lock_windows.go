//go:build windows

package bridge

import (
	"context"
	"errors"

	"golang.org/x/sys/windows"
)

func updateAcquireLock(ctx context.Context, root string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	file, err := updateOpenLock(root)
	if err != nil {
		return nil, err
	}
	overlapped := &windows.Overlapped{}
	for {
		err = windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped)
		if err == nil {
			return func() { _ = windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, overlapped); _ = file.Close() }, nil
		}
		if !errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			_ = file.Close()
			return nil, err
		}
		if err := updateWaitForLock(ctx); err != nil {
			_ = file.Close()
			return nil, err
		}
	}
}
