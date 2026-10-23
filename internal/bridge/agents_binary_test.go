package bridge

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"testing/iotest"
)

func TestInstallGoBuildFingerprint(t *testing.T) {
	for _, offset := range []int{0, 16, 64*1024 - 16, 64 * 1024, 2*64*1024 + 16} {
		for _, flags := range []byte{0, 1, 2, 3} {
			data := make([]byte, offset+32)
			copy(data[offset:], "\xff Go buildinf:")
			data[offset+14], data[offset+15] = 8, flags
			found, err := installHasGoBuildInfo(iotest.HalfReader(bytes.NewReader(data)))
			if err != nil || !found {
				t.Fatalf("offset %d, flags %d: %v, %v", offset, flags, found, err)
			}
		}
	}
	for _, data := range [][]byte{
		nil,
		[]byte("\xff Go buildinf:"),
		append([]byte{0}, append([]byte("\xff Go buildinf:\x08\x02"), make([]byte, 16)...)...),
		append([]byte("\xff Go buildinf:\x03\x02"), make([]byte, 16)...),
		append([]byte("\xff Go buildinf:\x08\xff"), make([]byte, 16)...),
	} {
		if found, err := installHasGoBuildInfo(bytes.NewReader(data)); err != nil || found {
			t.Fatalf("invalid header %x: %v, %v", data, found, err)
		}
	}
	want := errors.New("read failed")
	if _, err := installHasGoBuildInfo(iotest.ErrReader(want)); !errors.Is(err, want) {
		t.Fatal(err)
	}
}

func TestInstallGooseFingerprintFailsClosed(t *testing.T) {
	directory := t.TempDir()
	if installGooseExecutableMatches(directory) || installGooseExecutableMatches(filepath.Join(directory, "missing")) {
		t.Fatal("unreadable or non-regular executable accepted")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if installGooseExecutableMatches(executable) {
		t.Fatal("Go test binary accepted as the Rust coding agent")
	}
	file, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	if found, err := installHasGoBuildInfo(io.NewSectionReader(file, 0, 1<<30)); err != nil || !found {
		t.Fatalf("real Go binary: %v, %v", found, err)
	}
}
