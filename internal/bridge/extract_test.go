package bridge

import (
	"context"
	"strings"
	"testing"
)

// These fragments and fixed public results cover the retired Readability
// implementation's article selection, sanitization, metadata, and budgets.
func TestExtractReadabilityContracts(t *testing.T) {
	paragraph := "A careful browser inspection starts with the visible document, reads the relevant article, and keeps its surrounding context. This paragraph supplies enough natural prose for both Readability implementations to distinguish the article from navigation and unrelated page furniture. "
	fixtures := []struct {
		name, source, title, format string
		budget                      int
		metadata                    bool
	}{
		{"unicode whitespace", `<main><h2>Reading&nbsp;guide</h2><p>Visible&nbsp;text&#8239;with&#12288;spaces.</p></main>`, "Reading\u00a0guide", "markdown", 8000, true},
		{"article metadata", `<meta name="author" content="Ada Example"><meta property="og:site_name" content="Example Journal"><meta name="description" content="A concise editorial description."><nav><a href="/home">Home</a><a href="/login">Login</a></nav><article><h1>Reading the browser document</h1><p>` + paragraph + paragraph + `</p><p>Second paragraph with <strong>important facts</strong> and <a href="/source">a source</a>.</p></article><footer>Copyright footer</footer>`, "Reading the browser document", "markdown", 8000, true},
		{"byline and article selection", `<aside>Related links</aside><article><h1>Browser extraction experiment</h1><p class="byline">By Grace Writer</p><p>` + paragraph + paragraph + `</p><p>` + paragraph + `</p></article>`, "Browser extraction experiment", "text", 8000, true},
		{"hidden and inert content", `<main><h1>Collected facts</h1><p>` + paragraph + paragraph + `</p><script>throw new Error("script must never run")</script><div hidden>SECRET HIDDEN</div><p style="visibility:hidden">SECRET STYLE</p><input value="SECRET INPUT"><p>Visible conclusion.</p></main>`, "Collected facts", "text", 8000, true},
		{"small semantic fallback", `<nav>Navigation</nav><main><h2>Small guide</h2><p>Short useful content.</p><ol><li>First</li><li>Second</li></ol></main>`, "Small guide", "markdown", 8000, true},
		{"body fallback without metadata", `<div><p>Brief text &amp; punctuation.</p><a href="javascript:alert(1)">Unsafe</a><a href="/safe">Safe</a></div>`, "Ignored title", "markdown", 8000, false},
		{"bounded article markdown", `<article><h1>Long article</h1><p>` + paragraph + paragraph + `</p><pre>` + strings.Repeat("console.log(value);\n", 20) + `</pre></article>`, "Long article", "markdown", 170, true},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			actual := extractContentHTML(fixture.source, fixture.format, fixture.budget, fixture.title, fixture.metadata)
			assertJSONEqual(t, value(actual), readContractCase(t, "extraction", fixture.name))
		})
	}
}

func TestExtractSanitizesAndSelectsSemanticContent(t *testing.T) {
	result := extractContentHTML(`<nav>Menu</nav><main><h1>Useful title</h1><p>Hello <strong>reader</strong> &amp; friends.</p><script>if (a < b) { alert('secret') }</script><p hidden>hidden secret</p><div style="display:none">invisible</div><a href="javascript:alert(1)">unsafe link</a><a href="https://example.com">safe link</a><input value="password"></main><footer>Footer</footer>`, "markdown", 8000, "Page title", true)
	content := result.text("content")
	for _, excluded := range []string{"Menu", "Footer", "secret", "invisible", "password", "javascript:"} {
		if strings.Contains(content, excluded) {
			t.Fatalf("excluded content leaked: %s", content)
		}
	}
	for _, included := range []string{"# Useful title", "**reader**", "& friends", "[safe link](https://example.com)"} {
		if !strings.Contains(content, included) {
			t.Fatalf("missing %q: %s", included, content)
		}
	}
	if result.text("source") != "semantic-root" || result.text("title") != "Page title" {
		t.Fatalf("wrong extraction metadata: %s", value(result))
	}
}

func TestExtractRejectsTruncatedSnapshotAndHonorsCancellation(t *testing.T) {
	calls := 0
	send := func(ctx context.Context, method string, params object) (object, error) {
		calls++
		if method != "dom.get_html" {
			t.Fatalf("unexpected request %s", method)
		}
		return success("snapshot", object{"html": value("<main>partial</main>"), "truncated": value(true)}), nil
	}
	response, err := extractContentRequest(context.Background(), object{"includeMetadata": value(false)}, send)
	if err != nil || response.boolean("ok") || response.object("error").text("code") != "RESULT_TRUNCATED" {
		t.Fatalf("truncated snapshot accepted: %v %s", err, value(response))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = extractContentRequest(ctx, object{"includeMetadata": value(false)}, send)
	if err != context.Canceled || calls != 1 {
		t.Fatalf("cancelled extraction dispatched work: %v, %d calls", err, calls)
	}
}

func TestExtractSettlesAndPreservesMarkdownFence(t *testing.T) {
	count := 0
	response, err := extractContentRequest(context.Background(), object{"includeMetadata": value(false), "consistency": value("settled"), "format": value("markdown"), "textBudget": value(100)}, func(ctx context.Context, method string, params object) (object, error) {
		count++
		return success("snapshot", object{"html": value("<main><pre>" + strings.Repeat("long text ", 30) + "</pre></main>"), "truncated": value(false)}), nil
	})
	if err != nil || !response.boolean("ok") {
		t.Fatalf("extract failed: %v", err)
	}
	result := response.object("result")
	if count != 2 || result.object("settlement").boolean("timedOut") || !result.boolean("truncated") || strings.Count(result.text("content"), "```")%2 != 0 {
		t.Fatalf("bad settlement or truncation: %s", value(result))
	}
}
