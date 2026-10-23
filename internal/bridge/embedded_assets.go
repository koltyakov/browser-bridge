package bridge

import (
	"bytes"
	"compress/gzip"
	"io"
)

// Assets are trusted, checked-in generator output. Expand once at startup so
// installation and protocol discovery never need an external file or runtime.
func expandEmbeddedAsset(compressed []byte) []byte {
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		panic(err)
	}
	defer func() { _ = reader.Close() }()
	content, err := io.ReadAll(reader)
	if err != nil {
		panic(err)
	}
	return content
}
