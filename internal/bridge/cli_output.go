package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

var cliNull = json.RawMessage("null")
var cliANSI = regexp.MustCompile("\x1b\\[[0-9;]*[A-Za-z]|\x1b[^[]")

func cliString(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) > 0 && bytes.TrimSpace(raw)[0] == '"'
}
func cliNumberValue(raw json.RawMessage) (float64, bool) {
	var n float64
	if len(raw) == 0 || string(raw) == "null" || json.Unmarshal(raw, &n) != nil {
		return 0, false
	}
	return n, true
}
func cliBoolean(raw json.RawMessage) bool {
	return bytes.Equal(raw, []byte("true")) || bytes.Equal(raw, []byte("false"))
}
func cliArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	var a []json.RawMessage
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '[' || json.Unmarshal(raw, &a) != nil {
		return nil, false
	}
	return a, true
}
func cliRecord(raw json.RawMessage) object {
	if o, e := decodeObject(raw); e == nil {
		return o
	}
	if a, ok := cliArray(raw); ok {
		o := object{}
		for i, v := range a {
			o[strconv.Itoa(i)] = v
		}
		return o
	}
	return object{}
}
func cliPresent(raw json.RawMessage) bool { return len(raw) > 0 && string(raw) != "null" }
func cliTruthy(raw json.RawMessage) bool {
	if !cliPresent(raw) || string(raw) == "false" {
		return false
	}
	if cliString(raw) {
		var s string
		_ = json.Unmarshal(raw, &s)
		return s != ""
	}
	if n, ok := cliNumberValue(raw); ok {
		return n != 0
	}
	return true
}
func cliJSString(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if raw == nil {
		return "undefined"
	}
	if cliString(raw) {
		return cliDecodeString(raw)
	}
	if a, ok := cliArray(raw); ok {
		parts := []string{}
		for _, item := range a {
			if !cliPresent(item) {
				parts = append(parts, "")
			} else {
				parts = append(parts, cliJSString(item))
			}
		}
		return strings.Join(parts, ",")
	}
	if _, e := decodeObject(raw); e == nil {
		return "[object Object]"
	}
	return string(raw)
}
func cliDefault(o object, key, fallback string) string {
	if !cliPresent(o[key]) {
		return fallback
	}
	return cliJSString(o[key])
}
func cliPick(o object, keys ...string) object {
	out := object{}
	for _, key := range keys {
		if v, ok := o[key]; ok {
			out[key] = v
		}
	}
	return out
}
func cliClone(o object) object {
	out := object{}
	for k, v := range o {
		out[k] = v
	}
	return out
}
func cliLen(s string) int { return len(cliUTF16(s)) }
func cliSlice(s string, n int) string {
	units := cliUTF16(s)
	if len(units) > n {
		units = units[:n]
	}
	return cliFromUTF16(units)
}
func cliKeys(raw json.RawMessage) []string {
	if a, ok := cliArray(raw); ok {
		keys := []string{}
		for i := range a {
			keys = append(keys, strconv.Itoa(i))
		}
		return keys
	}
	if o, e := decodeObject(raw); e != nil || o == nil {
		return []string{}
	}
	return cliObjectKeys(raw)
}

// cliObjectKeys enumerates an already-decoded object without decoding all of
// its values again. Keep first-key order and let the decoded map supply the
// last value for duplicate keys, matching JavaScript object enumeration.
func cliObjectKeys(raw json.RawMessage) []string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	_, _ = dec.Token()
	keys := []string{}
	seen := map[string]bool{}
	for dec.More() {
		token, e := dec.Token()
		if e != nil {
			break
		}
		key, ok := token.(string)
		if !ok {
			break
		}
		var v json.RawMessage
		if dec.Decode(&v) != nil {
			break
		}
		if !seen[key] {
			keys = append(keys, key)
			seen[key] = true
		}
	}
	// ECMAScript enumerates array-index properties before other keys.
	sort.SliceStable(keys, func(i, j int) bool {
		a, ea := strconv.ParseUint(keys[i], 10, 32)
		b, eb := strconv.ParseUint(keys[j], 10, 32)
		ai := ea == nil && a < 4294967295 && strconv.FormatUint(a, 10) == keys[i]
		bi := eb == nil && b < 4294967295 && strconv.FormatUint(b, 10) == keys[j]
		if ai && bi {
			return a < b
		}
		return ai && !bi
	})
	return keys
}
func cliQuote(s string) []byte {
	return cliAppendQuote(make([]byte, 0, len(s)+2), s)
}
func cliAppendQuote(out []byte, s string) []byte {
	const hex = "0123456789abcdef"
	out = append(out, '"')
	for len(s) > 0 {
		// Most browser text is plain ASCII. Copy runs rather than appending
		// one rune at a time, especially for large exact schema payloads.
		i := 0
		for i < len(s) && s[i] >= 32 && s[i] < 128 && s[i] != '"' && s[i] != '\\' {
			i++
		}
		out = append(out, s[:i]...)
		s = s[i:]
		if len(s) == 0 {
			break
		}
		r, n := cliRune(s)
		s = s[n:]
		switch r {
		case '"', '\\':
			out = append(out, '\\', byte(r))
		case '\b':
			out = append(out, `\b`...)
		case '\f':
			out = append(out, `\f`...)
		case '\n':
			out = append(out, `\n`...)
		case '\r':
			out = append(out, `\r`...)
		case '\t':
			out = append(out, `\t`...)
		default:
			if r < 32 || r >= 0xd800 && r <= 0xdfff {
				out = append(out, '\\', 'u', hex[r>>12&15], hex[r>>8&15], hex[r>>4&15], hex[r&15])
			} else {
				out = cliAppendRune(out, r)
			}
		}
	}
	return append(out, '"')
}
func cliJSON(raw json.RawMessage, sanitize bool) []byte {
	if raw == nil {
		return nil
	}
	// Reuse one output buffer for the whole tree. Type dispatch also avoids
	// trying to decode every primitive as both an array and an object.
	return cliAppendJSON(make([]byte, 0, len(raw)), raw, sanitize)
}
func cliAppendJSON(out []byte, raw json.RawMessage, sanitize bool) []byte {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return out
	}
	switch raw[0] {
	case '"':
		s := cliDecodeString(raw)
		if sanitize && strings.ContainsRune(s, '\x1b') {
			s = cliANSI.ReplaceAllString(s, "")
		}
		return cliAppendQuote(out, s)
	case '[':
		if a, ok := cliArray(raw); ok {
			out = append(out, '[')
			for i, item := range a {
				if i > 0 {
					out = append(out, ',')
				}
				out = cliAppendJSON(out, item, sanitize)
			}
			return append(out, ']')
		}
	case '{':
		if o, e := decodeObject(raw); e == nil {
			out = append(out, '{')
			for i, k := range cliObjectKeys(raw) {
				if i > 0 {
					out = append(out, ',')
				}
				out = cliAppendQuote(out, k)
				out = append(out, ':')
				out = cliAppendJSON(out, o[k], sanitize)
			}
			return append(out, '}')
		}
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		if n, ok := cliNumberValue(raw); ok {
			if n == 0 {
				return append(out, '0')
			}
			format := 'f'
			if math.Abs(n) >= 1e21 || math.Abs(n) < 1e-6 {
				format = 'e'
			}
			s := strconv.FormatFloat(n, byte(format), -1, 64)
			s = strings.ReplaceAll(strings.ReplaceAll(s, "e-0", "e-"), "e+0", "e+")
			return append(out, s...)
		}
	}
	return append(out, raw...)
}
func writeCLIJSONOutput(out io.Writer, raw json.RawMessage, sanitize, pretty bool) error {
	data := cliJSON(raw, sanitize)
	if pretty {
		var formatted bytes.Buffer
		if err := json.Indent(&formatted, data, "", "  "); err != nil {
			return err
		}
		data = formatted.Bytes()
	}
	_, err := out.Write(append(data, '\n'))
	return err
}
func cliTTY(file *os.File) bool {
	stat, err := file.Stat()
	return err == nil && stat.Mode()&os.ModeCharDevice != 0
}

type cliPrintedError struct{}

func (cliPrintedError) Error() string { return "command failed" }

type cliBridgeError struct{ response object }

func (e cliBridgeError) Error() string { return e.response.object("error").text("message") }
func cliErrorPayload(err error) object {
	code := "ERROR"
	message := err.Error()
	var bridge cliBridgeError
	switch {
	case errors.As(err, &bridge):
		code = bridge.response.object("error").text("code")
	case errors.Is(err, os.ErrNotExist), errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.EINVAL):
		code = "DAEMON_OFFLINE"
	case errors.Is(err, context.DeadlineExceeded):
		code = "BRIDGE_TIMEOUT"
	case errors.Is(err, io.EOF), errors.Is(err, net.ErrClosed), strings.Contains(strings.ToLower(message), "socket closed"):
		code = "CONNECTION_LOST"
	}
	return object{"ok": value(false), "summary": value(code + ": " + message), "evidence": cliNull}
}
func reportCLIError(args []string, err error, out, stderr io.Writer) {
	var printed cliPrintedError
	if errors.As(err, &printed) {
		return
	}
	_, _, rest, remoteErr := extractRemote(args)
	command := ""
	if len(rest) > 0 {
		command = rest[0]
	}
	if remoteErr != nil || localOnlyCommand(command) && command != "doctor" && command != "restart" {
		_, _ = fmt.Fprintln(stderr, cliANSI.ReplaceAllString(err.Error(), ""))
		return
	}
	_ = writeCLIJSONOutput(out, value(cliErrorPayload(err)), true, false)
}

func cliCostClass(tokens float64) string {
	if tokens <= 250 {
		return "cheap"
	}
	if tokens <= 1000 {
		return "moderate"
	}
	if tokens <= 3000 {
		return "heavy"
	}
	return "extreme"
}
func cliAnnotate(summary, response object) object {
	out := cliClone(summary)
	meta := response.object("meta")
	sensitive := meta.text("method") == "sensitive.read"
	if timing := meta.object("timing"); timing != nil && !sensitive {
		out["timing"] = value(mcpPick(timing, "preparationMs queueMs executionMs totalMs scheduled"))
	}
	bytesN, bok := cliNumberValue(meta["transport_bytes"])
	if !bok {
		bytesN, bok = cliNumberValue(meta["response_bytes"])
	}
	tokens, tok := cliNumberValue(meta["transport_approx_tokens"])
	if !tok {
		tokens, tok = cliNumberValue(meta["approx_tokens"])
	}
	if sensitive {
		bytesN, tokens = 0, 0
	} else if !bok || !tok {
		payload := response["result"]
		if !response.boolean("ok") {
			payload = value(object{"error": response["error"]})
		}
		n := float64(len(cliJSON(payload, false)))
		if !bok {
			bytesN = n
		}
		if !tok {
			tokens = math.Ceil(n / 4)
		}
	}
	cost := ""
	for _, key := range []string{"transport_cost_class", "cost_class"} {
		candidate := meta.text(key)
		if candidate == "cheap" || candidate == "moderate" || candidate == "heavy" || candidate == "extreme" {
			cost = candidate
			break
		}
	}
	if cost == "" {
		cost = cliCostClass(tokens)
	}
	summaryBytes := len(cliJSON(value(summary), false))
	summaryTokens := int(math.Ceil(float64(summaryBytes) / 4))
	out["transportBytes"] = value(bytesN)
	out["transportTokens"] = value(tokens)
	out["transportCostClass"] = value(cost)
	out["summaryBytes"] = value(summaryBytes)
	out["summaryTokens"] = value(summaryTokens)
	out["summaryCostClass"] = value(cliCostClass(float64(summaryTokens)))
	return out
}
