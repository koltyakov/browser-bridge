package readability_test

import (
	"bytes"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	upstream "codeberg.org/readeck/go-readability/v2"
	"github.com/koltyakov/browser-bridge/internal/readability"
	"golang.org/x/net/html"
)

func render(t *testing.T, node *html.Node) string {
	t.Helper()
	if node == nil {
		return ""
	}
	var out bytes.Buffer
	if err := html.Render(&out, node); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

func compareDocument(t *testing.T, source string, pageURL *url.URL) {
	t.Helper()
	doc, err := html.Parse(strings.NewReader(source))
	if err != nil {
		t.Fatal(err)
	}
	before := render(t, doc)
	actual, actualErr := readability.FromDocument(doc, pageURL)
	if got := render(t, doc); got != before {
		t.Fatal("document-only extraction mutated the captured browser DOM")
	}
	expected, expectedErr := upstream.FromDocument(doc, pageURL)
	if (actualErr == nil) != (expectedErr == nil) || (actualErr != nil && actualErr.Error() != expectedErr.Error()) {
		t.Fatalf("error mismatch: local=%v upstream=%v", actualErr, expectedErr)
	}
	if render(t, actual.Node) != render(t, expected.Node) {
		t.Fatal("article HTML differs from pinned upstream")
	}
	got := []string{actual.Title(), actual.Byline(), actual.Excerpt(), actual.SiteName(), actual.ImageURL(), actual.Favicon(), actual.Language()}
	want := []string{expected.Title(), expected.Byline(), expected.Excerpt(), expected.SiteName(), expected.ImageURL(), expected.Favicon(), expected.Language()}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("metadata mismatch: local=%q upstream=%q", got, want)
	}
}

func TestDocumentOnlyMatchesUpstreamFixtureCorpus(t *testing.T) {
	output, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "codeberg.org/readeck/go-readability/v2").Output()
	if err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob(filepath.Join(strings.TrimSpace(string(output)), "test-pages", "*", "source.html"))
	if err != nil || len(files) < 20 {
		t.Fatalf("missing pinned upstream fixtures: count=%d error=%v", len(files), err)
	}
	pageURL, err := url.Parse("https://example.org/articles/test")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		t.Run(filepath.Base(filepath.Dir(file)), func(t *testing.T) {
			source, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			compareDocument(t, string(source), pageURL)
		})
	}
	t.Logf("compared %d pinned upstream documents", len(files))
}

func TestDocumentOnlyPreservesBrowserUnicodeWithoutCharsetDecoding(t *testing.T) {
	prose := strings.Repeat("日本語 café Ελληνικά العربية 中文 🧪 e\u0301. ", 50)
	// Browser snapshots are Unicode regardless of their original charset label.
	source := `<html lang="ja"><head><meta charset="shift_jis"><title>Unicode article</title></head><body><article><h1>日本語 café</h1><p>` + prose + `</p><a href="/relative">source</a></article></body></html>`
	compareDocument(t, source, nil)
	doc, err := html.Parse(strings.NewReader(source))
	if err != nil {
		t.Fatal(err)
	}
	article, err := readability.FromDocument(doc, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := render(t, article.Node)
	for _, text := range []string{"日本語", "café", "العربية", "中文", "🧪", "e\u0301", `href="/relative"`} {
		if !strings.Contains(got, text) {
			t.Fatalf("document content was recoded or relative URL changed: %q", text)
		}
	}
}

func TestWindowsRuntimeDoesNotImportCharsetReaders(t *testing.T) {
	cmd := exec.Command("go", "list", "-deps", "-tags=nethttpomithttp2,purego", "./cmd/bbx")
	cmd.Dir = "../.."
	cmd.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("list Windows runtime dependencies: %v\n%s", err, output)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "github.com/go-shiori/dom" ||
			strings.HasPrefix(dependency, "codeberg.org/readeck/go-readability/") ||
			strings.HasPrefix(dependency, "github.com/gogs/chardet") ||
			strings.HasPrefix(dependency, "golang.org/x/net/html/charset") ||
			strings.HasPrefix(dependency, "golang.org/x/text/") {
			t.Errorf("reader-only dependency retained by Windows runtime: %s", dependency)
		}
	}
}
