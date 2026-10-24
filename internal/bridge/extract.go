package bridge

import (
	"context"
	"html"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	readability "codeberg.org/readeck/go-readability/v2"
	nethtml "golang.org/x/net/html"
)

// extractContentRequest consumes bounded HTML snapshots locally. The callback
// must dispatch normal bridge requests, and must preserve routing and ownership.
func extractContentRequest(ctx context.Context, params object, send func(context.Context, string, object) (object, error)) (response object, err error) {
	defer func() {
		if response != nil && !response.boolean("ok") {
			meta := mcpClone(response.object("meta"))
			meta["method"] = value("page.extract_content")
			response["meta"] = value(meta)
		}
	}()
	format := params.text("format")
	if format == "" {
		format = "text"
	}
	if format != "text" && format != "markdown" {
		return failure("", "INVALID_REQUEST", "format must be text or markdown."), nil
	}
	consistency := params.text("consistency")
	if consistency == "" {
		consistency = "best_effort"
	}
	if consistency != "best_effort" && consistency != "settled" {
		return failure("", "INVALID_REQUEST", "consistency must be best_effort or settled."), nil
	}
	selector := strings.TrimSpace(params.text("selector"))
	if mcpStringLength(selector) > 2048 {
		return failure("", "INVALID_REQUEST", "selector must not exceed 2,048 characters."), nil
	}
	if selector == "" {
		selector = "body"
	}
	budget := int(params.number("textBudget"))
	if params["textBudget"] == nil {
		budget = 8000
	}
	budget = max(100, min(100000, budget))
	title := ""
	metadata := string(params["includeMetadata"]) != "false"
	if metadata {
		response, err := send(ctx, "page.get_state", object{})
		if err != nil || !response.boolean("ok") {
			return response, err
		}
		title = response.object("result").text("title")
	}
	read := func() (object, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return send(ctx, "dom.get_html", object{"target": value(object{"selector": value(selector)}), "outer": value(true), "maxLength": value(50000)})
	}
	response, err = read()
	if err != nil || !response.boolean("ok") {
		return response, err
	}
	snapshot := response.object("result")
	truncated := func(snapshot object) object {
		r := failure("", "RESULT_TRUNCATED", "The bounded HTML snapshot was too large for semantic extraction.")
		e := r.object("error")
		e["details"] = value(object{"selector": value(selector), "omitted": snapshot["omitted"], "maxLength": value(50000)})
		r["error"] = value(e)
		r["meta"] = value(object{"method": value("page.extract_content"), "continuation_hint": value("Retry with a narrower selector.")})
		return r
	}
	if snapshot.boolean("truncated") {
		return truncated(snapshot), nil
	}
	var settlement object
	if consistency == "settled" {
		timeout := params.number("settleTimeoutMs")
		if params["settleTimeoutMs"] == nil {
			timeout = 2000
		}
		timeout = max(100, min(timeout, 10000))
		deadline := time.Now().Add(time.Duration(timeout) * time.Millisecond)
		timedOut := false
		for {
			timer := time.NewTimer(100 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
			next, err := read()
			if err != nil || !next.boolean("ok") {
				return next, err
			}
			nextSnapshot := next.object("result")
			if nextSnapshot.boolean("truncated") {
				return truncated(nextSnapshot), nil
			}
			same := snapshot.text("html") == nextSnapshot.text("html")
			snapshot = nextSnapshot
			if same {
				break
			}
			if !time.Now().Before(deadline) {
				timedOut = true
				break
			}
		}
		settlement = object{"requested": value(true), "quietMs": value(100), "timedOut": value(timedOut)}
	}
	result := extractContentHTML(snapshot.text("html"), format, budget, title, metadata)
	root := result.object("root")
	if strings.TrimSpace(params.text("selector")) != "" {
		root["selector"] = value(strings.TrimSpace(params.text("selector")))
		result["root"] = value(root)
	}
	if settlement != nil {
		result["settlement"] = value(settlement)
	}
	out := success("extract_"+uniqueID(), result)
	out["meta"] = value(object{"method": value("page.extract_content"), "node_processed": value(true)})
	return out, nil
}

func (s *mcpSession) extractContent(ctx context.Context, params, args object, era string) (object, error) {
	return extractContentRequest(ctx, params, func(ctx context.Context, method string, params object) (object, error) {
		options := mcpClone(args)
		if method == "dom.get_html" {
			delete(options, "budgetPreset")
			options["_clearTokenBudget"] = value(true)
		}
		return s.bridge(ctx, method, params, options, era)
	})
}

type extractNode struct {
	tag, text string
	attrs     map[string]string
	children  []*extractNode
	parent    *extractNode
}

var extractSpace = regexp.MustCompile(`[\s\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)
var extractHiddenStyle = regexp.MustCompile(`(?i)display\s*:\s*none|visibility\s*:\s*hidden`)
var extractBlankLines = regexp.MustCompile(`\n{3,}`)
var extractTrailingSpace = regexp.MustCompile(`[ \t]+\n`)
var extractHorizontalSpace = regexp.MustCompile(`[ \t]+`)
var extractLineEdgeSpace = regexp.MustCompile(` ?\n ?`)

// Parse only the captured bytes. A nil Readability base URL preserves relative
// links, matching the npm parser's synthetic document, and never fetches URLs.
func extractDocument(source, title string) (*nethtml.Node, *extractNode) {
	document, _ := nethtml.Parse(strings.NewReader("<!doctype html><html><head><title>" + html.EscapeString(title) + "</title></head><body>" + source + "</body></html>"))
	var sanitize func(*nethtml.Node)
	sanitize = func(node *nethtml.Node) {
		for child := node.FirstChild; child != nil; {
			next := child.NextSibling
			if child.Type == nethtml.ElementNode && extractExcluded(extractShallowNode(child)) && child.Data != "head" {
				node.RemoveChild(child)
			} else {
				sanitize(child)
			}
			child = next
		}
	}
	sanitize(document)
	var body *nethtml.Node
	var findBody func(*nethtml.Node)
	findBody = func(node *nethtml.Node) {
		if node.Type == nethtml.ElementNode && node.Data == "body" {
			body = node
			return
		}
		for child := node.FirstChild; child != nil && body == nil; child = child.NextSibling {
			findBody(child)
		}
	}
	findBody(document)
	return document, extractFromHTMLNode(body)
}

func extractShallowNode(node *nethtml.Node) *extractNode {
	out := &extractNode{attrs: map[string]string{}}
	if node == nil {
		out.tag = "body"
		return out
	}
	switch node.Type {
	case nethtml.TextNode:
		out.text = node.Data
	case nethtml.ElementNode:
		out.tag = node.Data
	}
	for _, attr := range node.Attr {
		out.attrs[attr.Key] = attr.Val
	}
	return out
}

func extractFromHTMLNode(node *nethtml.Node) *extractNode {
	out := extractShallowNode(node)
	if node == nil {
		return out
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if child.Type != nethtml.ElementNode && child.Type != nethtml.TextNode {
			continue
		}
		converted := extractFromHTMLNode(child)
		converted.parent = out
		out.children = append(out.children, converted)
	}
	return out
}

func extractExcluded(node *extractNode) bool {
	switch node.tag {
	case "script", "style", "noscript", "template", "input", "textarea", "select", "option", "button", "head":
		return true
	}
	_, hidden := node.attrs["hidden"]
	return hidden || node.attrs["aria-hidden"] == "true" || extractHiddenStyle.MatchString(node.attrs["style"])
}
func extractText(node *extractNode) string {
	if extractExcluded(node) {
		return ""
	}
	if node.tag == "" {
		return node.text
	}
	var b strings.Builder
	for _, child := range node.children {
		b.WriteString(extractText(child))
	}
	return b.String()
}
func extractMarkdown(node *extractNode) string {
	if extractExcluded(node) {
		return ""
	}
	if node.tag == "" {
		return extractSpace.ReplaceAllString(node.text, " ")
	}
	var b strings.Builder
	for _, child := range node.children {
		b.WriteString(extractMarkdown(child))
	}
	children := b.String()
	trimmed := strings.TrimSpace(children)
	if len(node.tag) == 2 && node.tag[0] == 'h' && node.tag[1] >= '1' && node.tag[1] <= '6' {
		return "\n" + strings.Repeat("#", int(node.tag[1]-'0')) + " " + trimmed + "\n\n"
	}
	switch node.tag {
	case "p", "div", "section", "article", "main":
		return "\n" + trimmed + "\n\n"
	case "br":
		return "\n"
	case "hr":
		return "\n---\n"
	case "strong", "b":
		return "**" + trimmed + "**"
	case "em", "i":
		return "*" + trimmed + "*"
	case "code":
		if node.parent != nil && node.parent.tag == "pre" {
			return children
		}
		return "`" + strings.ReplaceAll(extractText(node), "`", "\\`") + "`"
	case "pre":
		return "\n```\n" + extractText(node) + "\n```\n\n"
	case "blockquote":
		return "\n> " + strings.ReplaceAll(trimmed, "\n", "\n> ") + "\n\n"
	case "li":
		marker := "-"
		if node.parent != nil && node.parent.tag == "ol" {
			index := 0
			for _, child := range node.parent.children {
				if child.tag != "" {
					index++
				}
				if child == node {
					break
				}
			}
			marker = strconv.Itoa(index) + "."
		}
		return "\n" + marker + " " + trimmed
	case "ul", "ol":
		return children + "\n\n"
	case "a":
		href := strings.TrimSpace(node.attrs["href"])
		lower := strings.ToLower(href)
		if href != "" && !strings.HasPrefix(lower, "javascript:") && !strings.HasPrefix(lower, "data:") {
			return "[" + trimmed + "](" + href + ")"
		}
		return trimmed
	}
	return children
}

func extractContentHTML(source, format string, budget int, title string, metadata bool) object {
	document, body := extractDocument(source, title)
	root := body
	origin := "body"
	best := 0
	var walk func(*extractNode)
	walk = func(node *extractNode) {
		if extractExcluded(node) {
			return
		}
		if node.tag == "article" || node.tag == "main" || node.attrs["role"] == "main" {
			length := mcpStringLength(strings.TrimSpace(extractSpace.ReplaceAllString(extractText(node), " ")))
			if length > best {
				root, best, origin = node, length, "semantic-root"
			}
		}
		for _, child := range node.children {
			walk(child)
		}
	}
	walk(body)
	article, err := readability.FromDocument(document, nil)
	var readable *extractNode
	if err == nil && article.Node != nil {
		readable = extractFromHTMLNode(article.Node)
		if mcpStringLength(extractText(readable)) >= max(200, best/5) {
			root = &extractNode{tag: "article", attrs: map[string]string{}, children: []*extractNode{readable}}
			readable.parent = root
			origin = "readability"
		}
	}
	content := extractText(root)
	if format == "markdown" {
		content = extractMarkdown(root)
		content = extractTrailingSpace.ReplaceAllString(content, "\n")
	} else {
		// Template indentation leaves whitespace-only lines; drop it so blank
		// lines collapse instead of costing tokens.
		content = extractHorizontalSpace.ReplaceAllString(content, " ")
		content = extractLineEdgeSpace.ReplaceAllString(content, "\n")
	}
	content = strings.TrimSpace(extractBlankLines.ReplaceAllString(content, "\n\n"))
	length := mcpStringLength(content)
	truncated := length > budget
	if truncated {
		units := utf16.Encode([]rune(content))
		boundary := -1
		for i := min(budget, len(units)-1); i >= 0; i-- {
			if units[i] == ' ' || (units[i] == '\n' && i+1 < len(units) && units[i+1] == '\n') {
				boundary = i
				break
			}
		}
		end := budget
		if boundary >= budget*7/10 {
			end = boundary
		}
		trimEnd := func(s string) string {
			return strings.TrimRightFunc(s, func(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' })
		}
		content = trimEnd(mcpSlice(content, end))
		if format == "markdown" && strings.Count(content, "```")%2 == 1 {
			content = trimEnd(mcpSlice(content, max(0, budget-4))) + "\n```"
		}
	}
	result := object{"format": value(format), "content": value(content), "source": value(origin), "root": value(object{"tag": value(root.tag)}), "length": value(length), "truncated": value(truncated), "omitted": value(length - mcpStringLength(content))}
	if metadata {
		metadataTitle := title
		if readable != nil {
			metadataTitle = article.Title()
		}
		for _, entry := range []struct {
			key, text string
			limit     int
		}{{"title", metadataTitle, 300}, {"byline", article.Byline(), 200}, {"excerpt", article.Excerpt(), 500}, {"siteName", article.SiteName(), 200}} {
			if normalized := strings.TrimSpace(extractSpace.ReplaceAllString(entry.text, " ")); normalized != "" {
				result[entry.key] = value(mcpSlice(normalized, entry.limit))
			}
		}
	}
	return result
}
