package bridge

import (
	"bytes"
	"errors"
	"io"
)

// Go's linker identifies build information with a 16-byte-aligned, 32-byte
// header. Only the fingerprint is needed here, not module or executable parsing.
// See https://go.dev/src/debug/buildinfo/buildinfo.go.
// This is a conservative exclusion for a setup hint, not binary authentication.
func installHasGoBuildInfo(reader io.Reader) (bool, error) {
	const headerSize = 32
	magic := []byte("\xff Go buildinf:")
	buffer := make([]byte, 64*1024)
	carry := 0
	for {
		n, err := io.ReadFull(reader, buffer[carry:])
		data := buffer[:carry+n]
		for offset := 0; offset+headerSize <= len(data); offset += 16 {
			header := data[offset : offset+headerSize]
			if bytes.HasPrefix(header, magic) && (header[14] == 4 || header[14] == 8) && header[15] <= 3 {
				return true, nil
			}
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		// Keep a complete header across reads. Both the chunk and overlap sizes
		// are multiples of 16, preserving the linker's alignment requirement.
		carry = copy(buffer, data[len(data)-headerSize:])
	}
}
