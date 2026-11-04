//go:build !windows

package bridge

import (
	"context"
	"errors"
)

func readNativeRegistrationRegistry(context.Context, string) (string, error) {
	return "", errors.New("native host registry lookup is only supported on Windows")
}
