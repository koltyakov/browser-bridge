package bridge

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

// The daemon socket and the native pipe accept bytes from other processes.
// Malformed input must produce an error or a decoded object, never a panic,
// and an oversized line must leave the stream positioned at the next line.
func FuzzReadWireLine(f *testing.F) {
	for _, seed := range []string{
		"{\"type\":\"agent.request\"}\n",
		"\n",
		"{\"a\":[1,2,{\"b\":null}]}\n{\"c\":1}\n",
		"not json\n",
		"{\"unterminated\":",
		"[1,2,3]\n",
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		reader := bufio.NewReader(bytes.NewReader(data))
		for range 8 {
			_, err := readWireLine(reader)
			if err == nil {
				continue
			}
			var oversized *oversizedLineError
			if errors.As(err, &oversized) {
				if skipErr := skipOversizedLine(reader, err); skipErr != nil {
					return
				}
				continue
			}
			return
		}
	})
}

func FuzzReadNative(f *testing.F) {
	frame := func(payload string) []byte {
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
		return append(header[:], payload...)
	}
	f.Add(frame("{\"type\":\"host.identity\"}"))
	f.Add(frame("[]"))
	f.Add([]byte{0, 0, 0, 0})
	f.Add([]byte{0xff, 0xff, 0xff, 0x7f, '{'})
	f.Fuzz(func(t *testing.T, data []byte) {
		reader := bytes.NewReader(data)
		for range 8 {
			// A skipped oversized frame keeps the stream; any other error ends it.
			if _, err := readNative(reader); err != nil && !errors.Is(err, errNativeFrameTooLarge) {
				return
			}
		}
	})
}

func FuzzRawObjectRoundTrip(f *testing.F) {
	f.Add([]byte("{\"id\":\"1\",\"ok\":true}"))
	f.Add([]byte("{\"k\\n\":\"v\"}"))
	f.Fuzz(func(t *testing.T, data []byte) {
		decoded, err := decodeObject(data)
		if err != nil {
			return
		}
		encoded := rawObject(decoded)
		if bytes.IndexByte(encoded, '\n') >= 0 {
			t.Fatalf("encoded object contains a newline and would break line framing: %q", encoded)
		}
		if _, err := decodeObject(encoded); err != nil {
			t.Fatalf("re-encoded object does not decode: %v", err)
		}
	})
}
