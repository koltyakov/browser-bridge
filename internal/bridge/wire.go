package bridge

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

// Keep the limit identical to MAX_JSON_LINE_BYTES / MAX_NATIVE_MESSAGE_BYTES.
const maxMessageBytes = protocol.MaxJSONLineBytes

type object map[string]json.RawMessage

func value[T interface{}](v T) json.RawMessage {
	b, err := encodeJSON(v)
	if err != nil {
		panic(err) // Only JSON-compatible, typed values are passed by this program.
	}
	return b
}

func encodeJSON[T interface{}](v T) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

func (o object) text(key string) string {
	var s string
	_ = json.Unmarshal(o[key], &s)
	return s
}

func (o object) boolean(key string) bool {
	return bytes.Equal(o[key], []byte("true"))
}

func (o object) number(key string) int64 {
	var n int64
	_ = json.Unmarshal(o[key], &n)
	return n
}

func (o object) object(key string) object {
	v, _ := decodeObject(o[key])
	return v
}

func decodeObject(b []byte) (object, error) {
	var result object
	if err := json.Unmarshal(b, &result); err != nil {
		return nil, err
	}
	if result == nil {
		return nil, errors.New("expected a JSON object")
	}
	return result, nil
}

func optionalObject(o object, key string) (object, error) {
	if raw := o[key]; raw == nil || bytes.Equal(raw, []byte("null")) {
		return object{}, nil
	}
	return decodeObject(o[key])
}

func uniqueID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func readLine(reader *bufio.Reader) (object, error) {
	var line []byte
	for {
		part, err := reader.ReadSlice('\n')
		if len(line)+len(part) > maxMessageBytes+1 {
			return nil, errors.New("bridge JSON line exceeds 1 MiB")
		}
		line = append(line, part...)
		if len(line) > maxMessageBytes && line[len(line)-1] != '\n' {
			return nil, errors.New("bridge JSON line exceeds 1 MiB")
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			if len(line) > maxMessageBytes {
				return nil, errors.New("bridge JSON line exceeds 1 MiB")
			}
			continue
		}
		if err != nil {
			if len(line) != 0 && errors.Is(err, io.EOF) {
				return nil, io.ErrUnexpectedEOF
			}
			return nil, err
		}
		return decodeObject(line)
	}
}

func readNative(reader io.Reader) (object, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint32(header[:])
	if size == 0 || size > protocol.MaxNativeMessageBytes {
		return nil, fmt.Errorf("invalid native message length: %d", size)
	}
	payload := make([]byte, int(size))
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, err
	}
	return decodeObject(payload)
}

// A single lock covers header and payload, including short writes. Native
// stdout must contain frames only, even when requests finish concurrently.
type wireWriter struct {
	once   sync.Once
	turn   chan struct{}
	out    io.Writer
	native bool
}

func (w *wireWriter) send(message object) error {
	_, err := w.sendContext(context.Background(), message)
	return err
}

// Report whether a write was attempted. Cancellation while queued must not
// dispatch a stale mutation or invalidate a connection used by other calls.
func (w *wireWriter) sendContext(ctx context.Context, message object) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	payload, err := encodeJSON(message)
	if err != nil {
		return false, err
	}
	limit := maxMessageBytes
	if w.native {
		limit = protocol.MaxNativeMessageBytes
	}
	if len(payload) > limit {
		return false, errors.New("bridge message exceeds 1 MiB")
	}
	if w.native {
		frame := make([]byte, 4, len(payload)+4)
		binary.LittleEndian.PutUint32(frame, uint32(len(payload)))
		payload = append(frame, payload...)
	} else {
		payload = append(payload, '\n')
	}
	w.once.Do(func() { w.turn = make(chan struct{}, 1) })
	select {
	case w.turn <- struct{}{}:
		defer func() { <-w.turn }()
	case <-ctx.Done():
		return false, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if conn, ok := w.out.(net.Conn); ok {
		deadline := time.Now().Add(5 * time.Second)
		if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
			deadline = limit
		}
		if err := conn.SetWriteDeadline(deadline); err != nil {
			return false, err
		}
		if ctx.Done() != nil {
			interrupted := make(chan struct{})
			stop := context.AfterFunc(ctx, func() {
				_ = conn.SetWriteDeadline(time.Now())
				close(interrupted)
			})
			defer func() {
				// Join the callback before another writer sets its own deadline.
				if !stop() {
					<-interrupted
				}
			}()
		}
	}
	for len(payload) > 0 {
		n, err := w.out.Write(payload)
		if err != nil {
			if ctx.Err() != nil {
				return true, ctx.Err()
			}
			if limit, ok := ctx.Deadline(); ok && !time.Now().Before(limit) {
				return true, context.DeadlineExceeded
			}
			return true, err
		}
		if n == 0 {
			return true, io.ErrShortWrite
		}
		payload = payload[n:]
	}
	return true, nil
}
