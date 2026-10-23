package bridge

import (
	"errors"
	"fmt"

	"github.com/pelletier/go-toml/v2"
)

func installValidateGrokConfig(raw string) error {
	// Parse semantic keys before the comment-preserving editor runs. Escaped
	// quoted keys and inline/dotted definitions must not hide a second transport.
	var config struct {
		Servers map[string]struct {
			URL       *string `toml:"url"`
			URI       *string `toml:"uri"`
			HTTPURL   *string `toml:"http_url"`
			Transport *string `toml:"transport"`
			Type      *string `toml:"type"`
		} `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal([]byte(raw), &config); err != nil {
		return fmt.Errorf("cannot safely edit Grok settings: %w", err)
	}
	entry, exists := config.Servers["browser-bridge"]
	if !exists {
		return nil
	}
	if entry.URL != nil || entry.URI != nil || entry.HTTPURL != nil || entry.Transport != nil || entry.Type != nil {
		return errors.New("existing Grok browser-bridge has a remote or explicit transport; migrate it before installing stdio")
	}
	statements, err := installTOMLStatements(raw)
	if err != nil {
		return err
	}
	for _, statement := range statements {
		match := installCodexHeader.FindStringSubmatch(statement.text)
		if match != nil && match[1] == "" {
			return nil
		}
	}
	return errors.New("inline, dotted or escaped Grok Browser Bridge definitions require manual migration to [mcp_servers.browser-bridge]")
}
