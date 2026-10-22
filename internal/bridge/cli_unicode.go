package bridge

import (
	"encoding/json"
	"strconv"
	"unicode/utf8"
)

// JavaScript slices UTF-16 code units. WTF-8 is used only inside the formatter
// to retain an unpaired surrogate until cliQuote emits its JSON escape.
func cliRune(s string) (rune, int) {
	if len(s) >= 3 && s[0] == 0xed && s[1] >= 0xa0 && s[1] <= 0xbf && s[2] >= 0x80 && s[2] <= 0xbf {
		return rune(s[0]&15)<<12 | rune(s[1]&63)<<6 | rune(s[2]&63), 3
	}
	return utf8.DecodeRuneInString(s)
}
func cliAppendRune(out []byte, r rune) []byte {
	if r >= 0xd800 && r <= 0xdfff {
		return append(out, byte(0xe0|r>>12), byte(0x80|(r>>6)&63), byte(0x80|r&63))
	}
	return utf8.AppendRune(out, r)
}
func cliUTF16(s string) []uint16 {
	units := []uint16{}
	for len(s) > 0 {
		r, n := cliRune(s)
		s = s[n:]
		if r > 0xffff {
			r -= 0x10000
			units = append(units, uint16(0xd800+r>>10), uint16(0xdc00+r&1023))
		} else {
			units = append(units, uint16(r))
		}
	}
	return units
}
func cliFromUTF16(units []uint16) string {
	out := []byte{}
	for i := 0; i < len(units); i++ {
		r := rune(units[i])
		if r >= 0xd800 && r <= 0xdbff && i+1 < len(units) && units[i+1] >= 0xdc00 && units[i+1] <= 0xdfff {
			r = 0x10000 + (r-0xd800)*1024 + rune(units[i+1]-0xdc00)
			i++
		}
		out = cliAppendRune(out, r)
	}
	return string(out)
}
func cliDecodeString(raw json.RawMessage) string {
	out := []byte{}
	for i := 1; i < len(raw)-1; i++ {
		if raw[i] != '\\' {
			out = append(out, raw[i])
			continue
		}
		i++
		switch raw[i] {
		case '"', '\\', '/':
			out = append(out, raw[i])
		case 'b':
			out = append(out, '\b')
		case 'f':
			out = append(out, '\f')
		case 'n':
			out = append(out, '\n')
		case 'r':
			out = append(out, '\r')
		case 't':
			out = append(out, '\t')
		case 'u':
			if i+4 >= len(raw) {
				return string(out)
			}
			n, e := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
			if e != nil {
				return string(out)
			}
			i += 4
			r := rune(n)
			if r >= 0xd800 && r <= 0xdbff && i+6 < len(raw) && raw[i+1] == '\\' && raw[i+2] == 'u' {
				low, e := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
				if e == nil && low >= 0xdc00 && low <= 0xdfff {
					r = 0x10000 + (r-0xd800)*1024 + rune(low-0xdc00)
					i += 6
				}
			}
			out = cliAppendRune(out, r)
		}
	}
	return string(out)
}
func cliStringValue(s string) json.RawMessage { return cliQuote(s) }
func cliText(o object, key string) string {
	if cliString(o[key]) {
		return cliJSString(o[key])
	}
	return ""
}
