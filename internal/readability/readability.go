// Package readability extracts articles from an already-parsed UTF-8 DOM.
// The algorithm is a pinned upstream subset. See README.md for provenance,
// regeneration, and the deliberately omitted reader and network APIs.
package readability

import (
	"net/url"

	"golang.org/x/net/html"
)

// FromDocument extracts an article without changing doc or fetching any URLs.
func FromDocument(doc *html.Node, pageURL *url.URL) (Article, error) {
	parser := NewParser()
	return parser.ParseDocument(doc, pageURL)
}
