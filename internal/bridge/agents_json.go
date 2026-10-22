package bridge

import (
	"encoding/json"
	"fmt"
	"strings"
)

// A small concrete-syntax parser retains every byte outside the edited value.
// It accepts JSON comments and trailing commas used by editor config files.
type installJSONMember struct {
	key   string
	start int
	value *installJSONNode
	comma int
}

type installJSONNode struct {
	start, end int
	kind       byte
	members    []installJSONMember
}

type installJSONParser struct {
	raw string
	pos int
}

func (p *installJSONParser) trivia() error {
	if p.pos == 0 && strings.HasPrefix(p.raw, "\xef\xbb\xbf") {
		p.pos = 3
	}
	for p.pos < len(p.raw) {
		switch p.raw[p.pos] {
		case ' ', '\t', '\r', '\n':
			p.pos++
		case '/':
			if strings.HasPrefix(p.raw[p.pos:], "//") {
				end := strings.IndexByte(p.raw[p.pos:], '\n')
				if end < 0 {
					p.pos = len(p.raw)
				} else {
					p.pos += end
				}
			} else if strings.HasPrefix(p.raw[p.pos:], "/*") {
				end := strings.Index(p.raw[p.pos+2:], "*/")
				if end < 0 {
					return fmt.Errorf("unterminated JSON comment at %d", p.pos)
				}
				p.pos += end + 4
			} else {
				return nil
			}
		default:
			return nil
		}
	}
	return nil
}

func (p *installJSONParser) stringToken() (string, error) {
	start := p.pos
	if start >= len(p.raw) || p.raw[start] != '"' {
		return "", fmt.Errorf("expected JSON string at %d", start)
	}
	p.pos++
	for p.pos < len(p.raw) {
		c := p.raw[p.pos]
		p.pos++
		if c == '\\' {
			p.pos++
			continue
		}
		if c == '"' {
			var s string
			err := json.Unmarshal([]byte(p.raw[start:p.pos]), &s)
			return s, err
		}
	}
	return "", fmt.Errorf("unterminated JSON string at %d", start)
}

func (p *installJSONParser) node(depth int) (*installJSONNode, error) {
	if depth > 128 {
		return nil, fmt.Errorf("JSON config nesting exceeds 128")
	}
	if err := p.trivia(); err != nil {
		return nil, err
	}
	if p.pos >= len(p.raw) {
		return nil, fmt.Errorf("unexpected end of JSON")
	}
	n := &installJSONNode{start: p.pos, kind: p.raw[p.pos]}
	switch n.kind {
	case '{', '[':
		p.pos++
		close := byte('}')
		if n.kind == '[' {
			close = ']'
		}
		seen := map[string]bool{}
		for {
			if err := p.trivia(); err != nil {
				return nil, err
			}
			if p.pos >= len(p.raw) {
				return nil, fmt.Errorf("unterminated JSON container")
			}
			if p.raw[p.pos] == close {
				p.pos++
				break
			}
			member := installJSONMember{start: p.pos, comma: -1}
			if n.kind == '{' {
				key, err := p.stringToken()
				if err != nil {
					return nil, err
				}
				if seen[key] {
					return nil, fmt.Errorf("duplicate JSON key %q", key)
				}
				seen[key], member.key = true, key
				if err := p.trivia(); err != nil {
					return nil, err
				}
				if p.pos >= len(p.raw) || p.raw[p.pos] != ':' {
					return nil, fmt.Errorf("expected colon at %d", p.pos)
				}
				p.pos++
			}
			child, err := p.node(depth + 1)
			if err != nil {
				return nil, err
			}
			member.value = child
			if err := p.trivia(); err != nil {
				return nil, err
			}
			if p.pos >= len(p.raw) {
				return nil, fmt.Errorf("unterminated JSON container")
			}
			if p.raw[p.pos] == ',' {
				member.comma = p.pos
				p.pos++
			} else if p.raw[p.pos] != close {
				return nil, fmt.Errorf("expected comma at %d", p.pos)
			}
			n.members = append(n.members, member)
		}
	case '"':
		if _, err := p.stringToken(); err != nil {
			return nil, err
		}
	default:
		for p.pos < len(p.raw) && !strings.ContainsRune(" \t\n\r,]} /", rune(p.raw[p.pos])) {
			p.pos++
		}
		token := p.raw[n.start:p.pos]
		if len(token) == 0 || !json.Valid([]byte(token)) {
			return nil, fmt.Errorf("invalid JSON value at %d", n.start)
		}
	}
	n.end = p.pos
	return n, nil
}

func installParseJSON(raw string) (*installJSONNode, error) {
	p := installJSONParser{raw: raw}
	n, err := p.node(0)
	if err != nil {
		return nil, err
	}
	if err := p.trivia(); err != nil {
		return nil, err
	}
	if p.pos != len(raw) || n.kind != '{' {
		return nil, fmt.Errorf("config must be a JSON object")
	}
	return n, nil
}

func installJSONLookup(n *installJSONNode, keys ...string) *installJSONNode {
	for _, key := range keys {
		if n == nil || n.kind != '{' {
			return nil
		}
		var found *installJSONNode
		for _, member := range n.members {
			if member.key == key {
				found = member.value
				break
			}
		}
		n = found
	}
	return n
}

func installJSONEdit(raw string, keys []string, replacement *string) (string, error) {
	root, err := installParseJSON(raw)
	if err != nil {
		return "", err
	}
	return installJSONEditNode(raw, root, keys, replacement)
}

func installJSONEditNode(raw string, n *installJSONNode, keys []string, replacement *string) (string, error) {
	if len(keys) == 0 || n.kind != '{' {
		return "", fmt.Errorf("MCP configuration block must be an object")
	}
	for index, member := range n.members {
		if member.key != keys[0] {
			continue
		}
		if len(keys) > 1 {
			return installJSONEditNode(raw, member.value, keys[1:], replacement)
		}
		if replacement != nil {
			return raw[:member.value.start] + *replacement + raw[member.value.end:], nil
		}
		start, end := member.start, member.value.end
		if member.comma >= 0 {
			// Keep comments between a value and its comma.
			return raw[:start] + raw[end:member.comma] + raw[member.comma+1:], nil
		}
		if index > 0 {
			comma := n.members[index-1].comma
			if comma >= 0 {
				return raw[:comma] + raw[comma+1:start] + raw[end:], nil
			}
		}
		return raw[:start] + raw[end:], nil
	}
	if replacement == nil {
		return raw, nil
	}
	newValue := *replacement
	for i := len(keys) - 1; i > 0; i-- {
		newValue = "{" + string(value(keys[i])) + ": " + newValue + "}"
	}
	insert := "\n" + strings.Repeat("  ", 1) + string(value(keys[0])) + ": " + newValue + "\n"
	// Insert after the last member's comma/value and before existing trivia.
	// This retains trailing comments, including an end-of-line // comment.
	pos := n.start + 1
	if len(n.members) > 0 {
		last := n.members[len(n.members)-1]
		pos = last.value.end
		if last.comma >= 0 {
			pos = last.comma + 1
		} else {
			insert = "," + insert
		}
	}
	return raw[:pos] + insert + raw[pos:], nil
}
