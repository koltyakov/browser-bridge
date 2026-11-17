package bridge

import (
	"embed"
	"errors"
	"io"
)

// These are static host-side bindings, not a JavaScript runtime. All browser
// requests still go through the caller's existing MCP tool and the Go bridge.
//
//go:embed generated/code-mode/*
var codeModeAssets embed.FS

func writeCodeModeAdapter(out io.Writer, args []string) error {
	format := "javascript"
	if len(args) == 1 {
		format = args[0]
	} else if len(args) > 1 {
		return errors.New("usage: bbx protocol adapter [javascript|declarations|typescript]")
	}
	extension := map[string]string{"javascript": "mjs", "declarations": "d.mts", "typescript": "ts"}[format]
	if extension == "" {
		return errors.New("usage: bbx protocol adapter [javascript|declarations|typescript]")
	}
	data, err := codeModeAssets.ReadFile("generated/code-mode/browser-bridge." + extension)
	if err != nil {
		return err
	}
	_, err = out.Write(data)
	return err
}
