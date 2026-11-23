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
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

// Keep the limit identical to MAX_JSON_LINE_BYTES / MAX_NATIVE_MESSAGE_BYTES.
const maxMessageBytes = protocol.MaxJSONLineBytes

// wireEnvelopeSlack lets the relay wrap a maximum-size native message in its
// daemon envelope ({"type":"agent.request","request":...}, about 43 bytes)
// without the wrapped line exceeding the socket limit.
const wireEnvelopeSlack = 4 << 10

// maxWireLineBytes bounds one socket line: a full message plus its envelope.
const maxWireLineBytes = maxMessageBytes + wireEnvelopeSlack

// errMessageTooLarge marks a single message over its transport limit. The
// connection stays usable; only that message fails.
var errMessageTooLarge = errors.New("bridge message exceeds 1 MiB")

// errNativeFrameTooLarge marks an inbound native frame that was discarded.
var errNativeFrameTooLarge = errors.New("native message exceeds 1 MiB and was discarded")

type object map[string]json.RawMessage

// valueEncodeFailures counts values that could not be encoded (a NaN float,
// say). daemon.metrics reports it; the value becomes null instead of crashing.
var valueEncodeFailures atomic.Int64

func value[T interface{}](v T) json.RawMessage {
	b, err := encodeJSON(v)
	if err != nil {
		// A panic here would take down the daemon and every connection. One
		// bad field degrades to null in one message instead.
		valueEncodeFailures.Add(1)
		return json.RawMessage("null")
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

// Encode an object whose values are already JSON without re-validating them.
// Values from value() or a decoded message are valid; a value holding a newline
// would break line framing, so it takes the compacting encoder instead.
func rawObject(o object) json.RawMessage {
	keys := make([]string, 0, len(o))
	size := 2
	for key, raw := range o {
		if len(raw) == 0 || bytes.IndexByte(raw, '\n') >= 0 || !plainKey(key) {
			return value(o)
		}
		keys = append(keys, key)
		size += len(key) + len(raw) + 4
	}
	sort.Strings(keys)
	out := make([]byte, 0, size)
	out = append(out, '{')
	for i, key := range keys {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, '"')
		out = append(out, key...)
		out = append(out, '"', ':')
		out = append(out, o[key]...)
	}
	return append(out, '}')
}

// Keys that encode to themselves inside JSON quotes.
func plainKey(key string) bool {
	for i := 0; i < len(key); i++ {
		if c := key[i]; c < 0x20 || c > 0x7e || c == '"' || c == '\\' {
			return false
		}
	}
	return true
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
	if json.Unmarshal(o[key], &n) == nil {
		return n
	}
	// Preserve exact int64 literals for native counters and timeout clamping.
	// Decimal/exponent spellings must match the schema's safe-integer rules.
	n, _ = serviceInteger(o, key)
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

// An oversized line leaves the reader inside that line unless its newline was
// already consumed. Callers that keep the stream call skipOversizedLine.
type oversizedLineError struct{ terminated bool }

func (e *oversizedLineError) Error() string { return "bridge JSON line exceeds 1 MiB" }

// Most messages fit in bufio's own buffer. Reuse overflow buffers across
// readers, with a process-wide retention bound independent of idle peer count.
var spareLines = make(chan []byte, 2)

func readLine(reader *bufio.Reader) (object, error) {
	return readLineLimit(reader, maxMessageBytes)
}

// readWireLine reads a daemon-socket line, which may carry a full native
// message plus its relay envelope.
func readWireLine(reader *bufio.Reader) (object, error) {
	return readLineLimit(reader, maxWireLineBytes)
}

func readLineLimit(reader *bufio.Reader, maxWireLineBytes int) (object, error) {
	part, err := reader.ReadSlice('\n')
	if len(part) > maxWireLineBytes+1 || (len(part) > maxWireLineBytes && err != nil) {
		return nil, &oversizedLineError{terminated: err == nil}
	}
	if err == nil {
		return decodeObject(part)
	}
	if !errors.Is(err, bufio.ErrBufferFull) {
		if len(part) > 0 && errors.Is(err, io.EOF) {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, err
	}
	var line []byte
	select {
	case line = <-spareLines:
	default:
	}
	defer func() {
		select {
		case spareLines <- line[:0]:
		default:
		}
	}()
	for {
		if len(line)+len(part) > maxWireLineBytes+1 {
			return nil, &oversizedLineError{terminated: err == nil}
		}
		if need := len(line) + len(part); need > cap(line) {
			next := make([]byte, len(line), min(maxWireLineBytes+1, max(need, 2*cap(line))))
			copy(next, line)
			line = next
		}
		line = append(line, part...)
		if len(line) > maxWireLineBytes && line[len(line)-1] != '\n' {
			return nil, &oversizedLineError{terminated: false}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			if len(line) > maxWireLineBytes {
				return nil, &oversizedLineError{terminated: false}
			}
			part, err = reader.ReadSlice('\n')
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

// Discard the rest of an oversized line without buffering it, so the next read
// starts at the following message.
func skipOversizedLine(reader *bufio.Reader, err error) error {
	var oversized *oversizedLineError
	if !errors.As(err, &oversized) || oversized.terminated {
		return nil
	}
	for {
		_, err := reader.ReadSlice('\n')
		if !errors.Is(err, bufio.ErrBufferFull) {
			return err
		}
	}
}

func readNative(reader io.Reader) (object, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint32(header[:])
	if size == 0 {
		return nil, fmt.Errorf("invalid native message length: %d", size)
	}
	if size > protocol.MaxNativeMessageBytes {
		// Skip the payload so the next frame is read from its header. Chrome
		// caps extension-to-host frames far higher, so this is one bad message,
		// not a broken stream.
		if _, err := io.CopyN(io.Discard, reader, int64(size)); err != nil {
			return nil, err
		}
		return nil, errNativeFrameTooLarge
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
	// lineLimit overrides the line limit; relay connections allow the
	// envelope slack on top of a full message.
	lineLimit int
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
	return w.sendPayloadContext(ctx, payload)
}

// Reuse already encoded queued frames instead of serializing large results a
// second time. The caller must not mutate the payload after handing it off.
func (w *wireWriter) sendPayloadContext(ctx context.Context, payload []byte) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	limit := maxMessageBytes
	if w.lineLimit > 0 {
		limit = w.lineLimit
	}
	if w.native {
		limit = protocol.MaxNativeMessageBytes
	}
	if len(payload) > limit {
		return false, errMessageTooLarge
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
