package bridge

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"strings"
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
	expected, err := os.ReadFile("generated/code-mode/browser-bridge.mjs")
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

func TestCodeModeEmbedsOnlyCompressedAdapters(t *testing.T) {
	var count, compressedBytes, plainBytes int
	if err := fs.WalkDir(codeModeAssets, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		if !strings.HasSuffix(path, ".gz") {
			t.Fatalf("uncompressed adapter embedded: %s", path)
		}
		compressed, err := codeModeAssets.ReadFile(path)
		if err != nil {
			return err
		}
		plain, err := os.ReadFile(strings.TrimSuffix(path, ".gz"))
		if err != nil {
			return err
		}
		if !bytes.Equal(expandEmbeddedAsset(compressed), plain) {
			t.Fatalf("compressed adapter differs from generated source: %s", path)
		}
		count++
		compressedBytes += len(compressed)
		plainBytes += len(plain)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if count != 3 || compressedBytes >= plainBytes/4 {
		t.Fatalf("expected three compact adapters; files=%d compressed=%d plain=%d", count, compressedBytes, plainBytes)
	}
}

var errCodeModeWrite = errors.New("output unavailable")

type codeModeBrokenWriter struct{}

func (codeModeBrokenWriter) Write([]byte) (int, error) { return 0, errCodeModeWrite }
