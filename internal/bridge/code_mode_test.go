package bridge

import (
	"bytes"
	"errors"
	"os"
	"testing"
)

func TestCodeModeAdapterExportIsExactAndOffline(t *testing.T) {
	for _, format := range []string{"javascript", "declarations", "typescript"} {
		var output bytes.Buffer
		if err := writeCodeModeAdapter(&output, []string{format}); err != nil {
			t.Fatal(err)
		}
		extension := map[string]string{"javascript": "mjs", "declarations": "d.mts", "typescript": "ts"}[format]
		expected, err := os.ReadFile("generated/code-mode/browser-bridge." + extension)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(output.Bytes(), expected) {
			t.Fatal("export changed generated code")
		}
	}
	var output bytes.Buffer
	if err := writeCodeModeAdapter(&output, nil); err != nil {
		t.Fatal(err)
	}
	expected, err := codeModeAssets.ReadFile("generated/code-mode/browser-bridge.mjs")
	if err != nil || !bytes.Equal(expected, output.Bytes()) {
		t.Fatal("default export is not ESM")
	}
	for _, args := range [][]string{{"unknown"}, {"javascript", "extra"}} {
		output.Reset()
		if err := writeCodeModeAdapter(&output, args); err == nil || output.Len() != 0 {
			t.Fatal("invalid export arguments emitted code")
		}
	}
	if err := writeCodeModeAdapter(codeModeBrokenWriter{}, nil); !errors.Is(err, errCodeModeWrite) {
		t.Fatal("output failure was swallowed")
	}
}

var errCodeModeWrite = errors.New("output unavailable")

type codeModeBrokenWriter struct{}

func (codeModeBrokenWriter) Write([]byte) (int, error) { return 0, errCodeModeWrite }
