package bridge

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// The Windows registry API distinguishes missing entries from access errors
// without parsing localized reg.exe output.
func readNativeRegistrationRegistry(_ context.Context, path string) (string, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, strings.TrimPrefix(path, `HKCU\`), registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer func() { _ = key.Close() }()
	value, kind, err := key.GetStringValue("")
	if errors.Is(err, registry.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if kind != registry.SZ || value == "" {
		return "", fmt.Errorf("native host registry value is not a REG_SZ path: %s", path)
	}
	return value, nil
}
