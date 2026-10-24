package bridge

import (
	"bytes"
	"compress/gzip"
	"sync"
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

func TestLazyEmbeddedAssetDefersExpansionAndSharesConcurrentResult(t *testing.T) {
	compressed := make([]byte, len(compressedSkillArchive))
	// Invalid bytes must not be read during loader construction.
	load := lazyEmbeddedAsset(compressed)
	copy(compressed, compressedSkillArchive)
	const readers = 32
	results := make(chan []byte, readers)
	var workers sync.WaitGroup
	for range readers {
		workers.Go(func() { results <- load() })
	}
	workers.Wait()
	close(results)
	want := expandEmbeddedAsset(compressedSkillArchive)
	var first []byte
	for got := range results {
		if !bytes.Equal(got, want) {
			t.Fatal("lazy expansion differs from the embedded skill archive")
		}
		if first == nil {
			first = got
		} else if &first[0] != &got[0] {
			t.Fatal("concurrent callers received separately expanded archives")
		}
	}
	// Future calls must use the cached result, not reread the compressed bytes.
	clear(compressed)
	if got := load(); &got[0] != &first[0] || !bytes.Equal(got, want) {
		t.Fatal("cached archive changed after its first expansion")
	}
}

func TestInstallSkillFilesConcurrentReadersGetIndependentFiles(t *testing.T) {
	want, err := installSkillFiles("agents")
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	for range 16 {
		workers.Go(func() {
			files, err := installSkillFiles("agents")
			if err != nil {
				t.Error(err)
				return
			}
			if len(files) != len(want) {
				t.Error("concurrent installer lost skill files")
			}
			for name, data := range files {
				if !bytes.Equal(data, want[name]) {
					t.Errorf("concurrent installer changed %s", name)
				}
				// Installers may append client-specific notes without mutating
				// another reader's files or the cached archive.
				clear(data)
			}
		})
	}
	workers.Wait()
}

var embeddedAssetBytesSink []byte
var embeddedAssetLoaderSink func() []byte

func BenchmarkEmbeddedSkillArchive(b *testing.B) {
	b.Run("eager_expand", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			embeddedAssetBytesSink = expandEmbeddedAsset(compressedSkillArchive)
		}
	})
	b.Run("lazy_unused", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			embeddedAssetLoaderSink = lazyEmbeddedAsset(compressedSkillArchive)
		}
	})
	b.Run("lazy_first_read", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			embeddedAssetBytesSink = lazyEmbeddedAsset(compressedSkillArchive)()
		}
	})
	b.Run("lazy_cached", func(b *testing.B) {
		load := lazyEmbeddedAsset(compressedSkillArchive)
		embeddedAssetBytesSink = load()
		b.ReportAllocs()
		b.ResetTimer()
		for b.Loop() {
			embeddedAssetBytesSink = load()
		}
	})
}
