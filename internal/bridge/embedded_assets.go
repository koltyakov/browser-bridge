package bridge

import (
	"bytes"
	"compress/gzip"
	"io"
	"sync"
)

// Assets are trusted, checked-in generator output. Callers choose whether to
// expand at startup or on first use, without an external file or runtime.
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

// Installation assets are unused by ordinary CLI, daemon, and native-host calls.
// Cache the first expansion and safely share its read-only bytes across callers.
func lazyEmbeddedAsset(compressed []byte) func() []byte {
	return sync.OnceValue(func() []byte { return expandEmbeddedAsset(compressed) })
}
