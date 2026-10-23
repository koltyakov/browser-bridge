package bridge

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Edit nodes rather than decoding to a map so comments and policy fields survive.
// Reject ambiguous documents before making any change, including duplicate keys.
func installGooseDocument(raw string) (*yaml.Node, error) {
	decoder := yaml.NewDecoder(strings.NewReader(raw))
	var doc yaml.Node
	if err := decoder.Decode(&doc); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("Goose settings must contain exactly one YAML document")
	}
	if len(doc.Content) == 0 {
		doc.Kind = yaml.DocumentNode
		doc.Content = []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}
		doc.Content[0].HeadComment = strings.TrimSpace(raw)
	}
	var validate func(*yaml.Node) error
	validate = func(node *yaml.Node) error {
		if node.Kind == yaml.MappingNode {
			seen := map[string]bool{}
			for i := 0; i < len(node.Content); i += 2 {
				key := node.Content[i]
				if key.Kind != yaml.ScalarNode || seen[key.Value] {
					return errors.New("Goose settings contain complex or duplicate YAML keys")
				}
				seen[key.Value] = true
			}
		}
		for _, child := range node.Content {
			if err := validate(child); err != nil {
				return err
			}
		}
		return nil
	}
	if err := validate(&doc); err != nil {
		return nil, err
	}
	return &doc, nil
}

func installYAMLMapping(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode || node.Anchor != "" {
		return errors.New("Goose extension settings must be YAML mappings, not aliases or scalars")
	}
	for i := 0; i < len(node.Content); i += 2 {
		if node.Content[i].Value == "<<" {
			return errors.New("Goose settings use a YAML merge on the edited path; resolve it before installing")
		}
	}
	return nil
}

func installYAMLLookup(node *yaml.Node, key string) *yaml.Node {
	if node.Kind == yaml.MappingNode {
		for i := 0; i < len(node.Content); i += 2 {
			if node.Content[i].Value == key {
				return node.Content[i+1]
			}
		}
	}
	return nil
}

func installYAMLSet(node *yaml.Node, key string, replacement *yaml.Node) {
	if existing := installYAMLLookup(node, key); existing != nil {
		replacement.HeadComment = existing.HeadComment
		replacement.LineComment = existing.LineComment
		replacement.FootComment = existing.FootComment
		*existing = *replacement
		return
	}
	node.Content = append(node.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, replacement)
}

func installYAMLUnsharedEntry(node *yaml.Node) error {
	if node.Anchor != "" || node.Kind == yaml.AliasNode {
		return errors.New("Goose browser-bridge uses YAML anchors or aliases; resolve them before editing")
	}
	for _, child := range node.Content {
		if err := installYAMLUnsharedEntry(child); err != nil {
			return err
		}
	}
	return nil
}

func installGooseMCPConfigured(raw string) bool {
	doc, err := installGooseDocument(raw)
	if err != nil {
		return false
	}
	extensions := installYAMLLookup(doc.Content[0], "extensions")
	return extensions != nil && installYAMLLookup(extensions, "browser-bridge") != nil
}

func installUpdateGooseConfig(raw string, remove bool) (string, error) {
	doc, err := installGooseDocument(raw)
	if err != nil {
		return "", err
	}
	root := doc.Content[0]
	if err := installYAMLMapping(root); err != nil {
		return "", err
	}
	extensions := installYAMLLookup(root, "extensions")
	if extensions == nil {
		if remove {
			return raw, nil
		}
		extensions = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		installYAMLSet(root, "extensions", extensions)
	}
	if err := installYAMLMapping(extensions); err != nil {
		return "", err
	}
	entry := installYAMLLookup(extensions, "browser-bridge")
	if entry != nil {
		if err := installYAMLUnsharedEntry(entry); err != nil {
			return "", err
		}
	}
	if remove {
		if entry == nil {
			return raw, nil
		}
		for i := 0; i < len(extensions.Content); i += 2 {
			if extensions.Content[i].Value == "browser-bridge" {
				extensions.Content = append(extensions.Content[:i], extensions.Content[i+2:]...)
				break
			}
		}
	} else {
		fresh := entry == nil
		if fresh {
			entry = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			installYAMLSet(extensions, "browser-bridge", entry)
		}
		if err := installYAMLMapping(entry); err != nil {
			return "", err
		}
		for _, field := range []string{"uri", "url", "transport", "command"} {
			if installYAMLLookup(entry, field) != nil {
				return "", fmt.Errorf("existing Goose browser-bridge uses %s; migrate that transport explicitly", field)
			}
		}
		if kind := installYAMLLookup(entry, "type"); kind != nil && (kind.Kind != yaml.ScalarNode || kind.Value != "stdio") {
			return "", errors.New("existing Goose browser-bridge is not stdio; migrate that transport explicitly")
		}
		for _, field := range [][2]string{{"type", "stdio"}, {"name", "browser-bridge"}, {"cmd", "bbx"}} {
			installYAMLSet(entry, field[0], &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: field[1]})
		}
		args := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Style: yaml.FlowStyle}
		for _, arg := range []string{"mcp", "serve"} {
			args.Content = append(args.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: arg})
		}
		installYAMLSet(entry, "args", args)
		if fresh {
			installYAMLSet(entry, "enabled", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"})
		}
	}
	var output bytes.Buffer
	encoder := yaml.NewEncoder(&output)
	encoder.SetIndent(2)
	if err := encoder.Encode(doc); err != nil {
		return "", err
	}
	if err := encoder.Close(); err != nil {
		return "", err
	}
	return output.String(), nil
}
