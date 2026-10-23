package bridge

import (
	"bytes"
	"compress/gzip"
	"testing"
)

func TestEmbeddedAssetsExpandAndRejectCorruption(t *testing.T) {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write([]byte("asset content")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if got := string(expandEmbeddedAsset(compressed.Bytes())); got != "asset content" {
		t.Fatal(got)
	}
	for _, data := range [][]byte{nil, compressed.Bytes()[:compressed.Len()-5]} {
		func() {
			defer func() {
				if recover() == nil {
					t.Error("corrupt embedded asset accepted")
				}
			}()
			expandEmbeddedAsset(data)
		}()
	}
}
