package bridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type cliInvoker func(context.Context, string, object) (object, error)

func isFileCommand(command string) bool {
	switch command {
	case "upload", "paste-image", "download", "screenshot", "har", "record", "replay":
		return true
	}
	return false
}
func fileRoute(args []string) (object, []string, error) {
	flags := []string{"page.get_state"}
	rest := []string{}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--tab", "--extension", "--browser", "--profile":
			if i+1 >= len(args) {
				return nil, nil, fmt.Errorf("%s requires a value", args[i])
			}
			flags = append(flags, args[i], args[i+1])
			i++
		default:
			rest = append(rest, args[i])
		}
	}
	route, err := parseCLI(flags)
	return route, rest, err
}
func runFileCLI(ctx context.Context, c config, args []string) (runErr error) {
	route, rest, err := fileRoute(args[1:])
	if err != nil {
		return err
	}
	command := args[0]
	var cl *client
	var actionResponse object
	defer func() {
		var bridge cliBridgeError
		if !errors.As(runErr, &bridge) {
			return
		}
		method := bridge.response.object("meta").text("method")
		if (command == "upload" || command == "paste-image") && (method == "input.set_files" || method == "input.paste_image") || command == "download" && method == "download.resource" || command == "screenshot" && method == "screenshot.capture_element" || command == "har" && method == "network.export_har" {
			hint := ""
			if command == "upload" || command == "paste-image" {
				hint = method
			}
			runErr = printCLIResponse(bridge.response, false, hint)
		} else if command == "record" || command == "replay" || command == "upload" || command == "paste-image" || method == "artifact.read" {
			runErr = errors.New(bridge.Error())
		}
	}()
	call := func(ctx context.Context, method string, params object) (object, error) {
		if cl == nil {
			var err error
			cl, err = connect(c, "agent")
			if err != nil {
				return nil, err
			}
		}
		response, err := requestCLIResponse(ctx, cl, route, method, params)
		if err != nil {
			return nil, err
		}
		if method == "input.set_files" || method == "input.paste_image" {
			actionResponse = response
		}
		if !response.boolean("ok") {
			meta := response.object("meta")
			if meta == nil {
				meta = object{}
			}
			meta["method"] = value(method)
			response["meta"] = value(meta)
			return nil, cliBridgeError{response}
		}
		return response.object("result"), nil
	}
	defer func() {
		if cl != nil {
			cl.close()
		}
	}()
	switch command {
	case "upload", "paste-image":
		if route.number("tab_id") == 0 {
			return errors.New("upload requires --tab so every chunk targets the same tab")
		}
		if len(rest) < 2 {
			return errors.New("usage: bbx upload --tab <id> <ref|selector> <local-file>...")
		}
		target, err := atomicTarget(rest[0])
		if err != nil {
			return err
		}
		action := "input.set_files"
		if command == "paste-image" {
			action = "input.paste_image"
		}
		_, err = uploadCLIFiles(ctx, call, target, rest[1:], action)
		if err != nil {
			return err
		}
		return printCLIResponse(actionResponse, false, action)
	case "download":
		if route.number("tab_id") == 0 || len(rest) != 2 {
			return errors.New("usage: bbx download --tab <id> <url> <outPath>")
		}
		r, err := call(ctx, "download.resource", object{"url": value(rest[0])})
		if err != nil {
			return err
		}
		data, err := downloadCLIArtifact(ctx, call, r.object("artifact"), "resource")
		if err != nil {
			return err
		}
		if err = writeCLIFile(rest[1], data); err != nil {
			return err
		}
		return printJSON(object{"ok": value(true), "path": value(rest[1]), "byteLength": value(len(data))})
	case "screenshot":
		return screenshotCLI(ctx, call, rest)
	case "har":
		return harCLI(ctx, call, rest)
	case "record":
		if route.number("tab_id") == 0 || len(rest) != 2 {
			return errors.New("usage: bbx record --tab <id> <options-json> <out.json|out.html|out.mp4>")
		}
		b, err := readCLIInput(rest[0])
		if err != nil {
			return err
		}
		options, err := decodeObject(b)
		if err != nil {
			return err
		}
		result, err := recordCLI(ctx, call, options, rest[1])
		if err != nil {
			return err
		}
		result["ok"] = value(true)
		return printJSON(result)
	case "replay":
		if len(rest) != 2 {
			return errors.New("usage: bbx replay <journalId|recording-file> <out.html|out.json|out.mp4>")
		}
		result, err := exportCLIReplay(ctx, call, rest[0], rest[1])
		if err != nil {
			return err
		}
		result["ok"] = value(true)
		return printJSON(result)
	}
	return errors.New("unknown file command")
}
func cleanupCLICall(call cliInvoker, method string, params object) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = call(ctx, method, params)
}
func downloadCLIArtifact(ctx context.Context, call cliInvoker, artifact object, kind string) ([]byte, error) {
	id := artifact.text("artifactId")
	if id == "" {
		return nil, errors.New("missing artifact descriptor")
	}
	defer cleanupCLICall(call, "artifact.delete", object{"artifactId": value(id)})
	if artifact.text("kind") != kind {
		return nil, fmt.Errorf("artifact kind does not match expected %s", kind)
	}
	if kind == "har" && artifact.text("mimeType") != "application/json" {
		return nil, errors.New("invalid HAR artifact MIME type")
	}
	size := artifact.number("byteLength")
	if size < 0 || size > 128*1024*1024 {
		return nil, errors.New("invalid artifact byteLength")
	}
	var out bytes.Buffer
	for offset := int64(0); offset < size; {
		r, err := call(ctx, "artifact.read", object{"artifactId": value(id), "offset": value(offset)})
		if err != nil {
			return nil, err
		}
		if r.text("artifactId") != id || r.number("offset") != offset {
			return nil, errors.New("artifact chunk metadata is inconsistent")
		}
		data, err := decodeCLIBase64(r.text("data"))
		if err != nil || int64(len(data)) != r.number("byteLength") || offset+int64(len(data)) > size {
			return nil, errors.New("artifact chunk contains invalid base64 data")
		}
		out.Write(data)
		if string(r["nextOffset"]) == "null" {
			break
		}
		next := r.number("nextOffset")
		if next != offset+int64(len(data)) || next <= offset {
			return nil, errors.New("artifact chunk did not advance the read offset")
		}
		offset = next
	}
	sum := sha256.Sum256(out.Bytes())
	if int64(out.Len()) != size || hex.EncodeToString(sum[:]) != artifact.text("sha256") {
		return nil, errors.New("artifact length or checksum does not match capture metadata")
	}
	return out.Bytes(), nil
}
func decodeCLIBase64(s string) ([]byte, error) {
	b, e := base64.StdEncoding.DecodeString(s)
	if e != nil || base64.StdEncoding.EncodeToString(b) != s {
		return nil, errors.New("invalid canonical base64")
	}
	return b, nil
}
func uploadCLIFiles(ctx context.Context, call cliInvoker, target object, paths []string, action string) (object, error) {
	if len(paths) < 1 || len(paths) > 10 {
		return nil, errors.New("provide 1..10 local files")
	}
	if action == "input.paste_image" && len(paths) != 1 {
		return nil, errors.New("paste requires exactly one PNG")
	}
	type upload struct {
		file *os.File
		name string
		size int64
	}
	opened := []upload{}
	handles := []string{}
	defer func() {
		for _, item := range opened {
			_ = item.file.Close()
		}
		for _, id := range handles {
			cleanupCLICall(call, "files.release", object{"transferId": value(id)})
		}
	}()
	var total int64
	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		opened = append(opened, upload{file: f, name: filepath.Base(path)})
		stat, err := f.Stat()
		if err != nil {
			return nil, err
		}
		if !stat.Mode().IsRegular() || stat.Size() > 16*1024*1024 {
			return nil, errors.New("each upload must be a regular file of at most 16 MiB")
		}
		opened[len(opened)-1].size = stat.Size()
		total += stat.Size()
	}
	if total > 32*1024*1024 {
		return nil, errors.New("combined upload size exceeds 32 MiB")
	}
	for _, item := range opened {
		offset := int64(0)
		id := ""
		for {
			size := min(int64(196608), item.size-offset)
			data := make([]byte, int(size))
			if _, err := io.ReadFull(item.file, data); err != nil {
				return nil, errors.New("upload file changed while reading")
			}
			p := object{"offset": value(offset), "data": value(base64.StdEncoding.EncodeToString(data))}
			if id == "" {
				p["name"] = value(item.name)
				p["size"] = value(item.size)
				p["mimeType"] = value(uploadMIME(item.name))
			} else {
				p["transferId"] = value(id)
			}
			r, err := call(ctx, "files.stage", p)
			if err != nil {
				return nil, err
			}
			if id == "" {
				id = r.text("transferId")
				if id == "" {
					return nil, errors.New("missing transfer handle")
				}
				handles = append(handles, id)
			}
			if r.text("transferId") != id || r.number("nextOffset") != offset+size {
				return nil, errors.New("invalid file staging acknowledgement")
			}
			offset += size
			if offset >= item.size {
				break
			}
		}
	}
	params := object{"target": value(target)}
	if action == "input.paste_image" {
		params["transferId"] = value(handles[0])
	} else {
		params["files"] = value(handles)
	}
	return call(ctx, action, params)
}
func uploadMIME(name string) string {
	types := map[string]string{".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".html": "text/html", ".zip": "application/zip"}
	if mime := types[strings.ToLower(filepath.Ext(name))]; mime != "" {
		return mime
	}
	return "application/octet-stream"
}
func parseCaptureFlags(args []string, allowed map[string]string) (object, []string, error) {
	options := object{}
	rest := []string{}
	for i := 0; i < len(args); i++ {
		key, ok := allowed[args[i]]
		if !ok {
			if strings.HasPrefix(args[i], "--") {
				return nil, nil, fmt.Errorf("unknown option %s", args[i])
			}
			rest = append(rest, args[i])
			continue
		}
		flag := args[i]
		if _, ok := options[key]; ok {
			return nil, nil, fmt.Errorf("duplicate option %s", flag)
		}
		i++
		if i >= len(args) || strings.HasPrefix(args[i], "--") {
			return nil, nil, fmt.Errorf("%s requires a value", flag)
		}
		options[key] = value(args[i])
	}
	return options, rest, nil
}
func screenshotCLI(ctx context.Context, call cliInvoker, args []string) error {
	p, rest, err := parseCaptureFlags(args, map[string]string{"--format": "format", "--quality": "quality"})
	if err != nil {
		return err
	}
	format := p.text("format")
	if format == "" {
		format = "png"
	}
	if format != "png" && format != "jpeg" && format != "webp" {
		return errors.New("--format must be png, jpeg, or webp")
	}
	p["format"] = value(format)
	if q := p.text("quality"); q != "" {
		n, e := strconv.Atoi(q)
		if e != nil || n < 0 || n > 100 {
			return errors.New("--quality must be an integer from 0 to 100")
		}
		p["quality"] = value(n)
	}
	if len(rest) < 1 || len(rest) > 2 {
		return errors.New("usage: bbx screenshot [--format png|jpeg|webp] [--quality 0-100] <ref|selector> [path]")
	}
	ext := format
	if ext == "jpeg" {
		ext = "jpg"
	}
	output := filepath.Join(os.TempDir(), fmt.Sprintf("bbx-%d.%s", time.Now().UnixMilli(), ext))
	if len(rest) == 2 {
		output = rest[1]
		suffix := filepath.Ext(output)
		if suffix == "" {
			output += "." + ext
		} else if suffix != "."+ext && (format != "jpeg" || suffix != ".jpeg") {
			return errors.New("screenshot path extension must match format")
		}
	}
	ref := rest[0]
	if !strings.HasPrefix(ref, "el_") {
		r, e := call(ctx, "dom.query", object{"selector": value(ref)})
		if e != nil {
			return e
		}
		var nodes []object
		if json.Unmarshal(r["nodes"], &nodes) != nil || len(nodes) == 0 || nodes[0].text("elementRef") == "" {
			return fmt.Errorf("no element found for selector %q", ref)
		}
		ref = nodes[0].text("elementRef")
	}
	p["elementRef"] = value(ref)
	p["delivery"] = value("artifact")
	r, err := call(ctx, "screenshot.capture_element", p)
	if err != nil {
		return err
	}
	var data []byte
	if r.text("delivery") == "artifact" {
		data, err = downloadCLIArtifact(ctx, call, r.object("artifact"), "screenshot")
	} else {
		image := r.text("image")
		header, raw, ok := strings.Cut(image, ",")
		if !ok || (header != "data:image/png;base64" && header != "data:image/jpeg;base64" && header != "data:image/webp;base64") {
			return errors.New("invalid screenshot data URL")
		}
		data, err = decodeCLIBase64(raw)
	}
	if err != nil {
		return err
	}
	if err = writeCLIFile(output, data); err != nil {
		return err
	}
	evidence := object{"savedTo": value(output)}
	for _, key := range []string{"rect", "dimensions", "context", "format", "complete", "clipped"} {
		if v, ok := r[key]; ok {
			evidence[key] = v
		}
	}
	return printJSON(object{"ok": value(true), "summary": value("Screenshot saved to " + output + "."), "evidence": value(evidence)})
}
func harCLI(ctx context.Context, call cliInvoker, args []string) error {
	p, rest, err := parseCaptureFlags(args, map[string]string{"--limit": "limit", "--url-pattern": "urlPattern", "--delivery": "delivery"})
	if err != nil {
		return err
	}
	if limit := p.text("limit"); limit != "" {
		n, e := strconv.Atoi(limit)
		if e != nil || n < 1 || n > 200 {
			return errors.New("--limit must be an integer from 1 to 200")
		}
		p["limit"] = value(n)
	}
	delivery := p.text("delivery")
	if delivery == "" {
		delivery = "auto"
	}
	if delivery != "auto" && delivery != "inline" && delivery != "artifact" {
		return errors.New("--delivery must be inline, artifact, or auto")
	}
	p["delivery"] = value(delivery)
	output := "browser-bridge.har"
	if len(rest) > 1 {
		return errors.New("usage: bbx har [options] [outPath]")
	}
	if len(rest) == 1 {
		output = rest[0]
	}
	if filepath.Ext(output) != ".har" {
		return errors.New("HAR output path must use the .har extension")
	}
	r, err := call(ctx, "network.export_har", p)
	if err != nil {
		return err
	}
	data := []byte(r["har"])
	if r.text("delivery") == "artifact" {
		data, err = downloadCLIArtifact(ctx, call, r.object("artifact"), "har")
		if err != nil {
			return err
		}
	}
	if err = validateCLIHAR(data); err != nil {
		return err
	}
	if err = writeCLIFile(output, data); err != nil {
		return err
	}
	return printJSON(object{"ok": value(true), "summary": value("HAR saved to " + output + "."), "evidence": value(object{"savedTo": value(output), "delivery": r["delivery"]})})
}
func validateCLIHAR(data []byte) error {
	if !utf8.Valid(data) {
		return errors.New("HAR artifact is not valid UTF-8 JSON")
	}
	doc, err := decodeObject(data)
	if err != nil {
		return err
	}
	log := doc.object("log")
	var entries []json.RawMessage
	if log.text("version") != "1.2" || json.Unmarshal(log["entries"], &entries) != nil || string(log["entries"]) == "null" {
		return errors.New("HAR response does not contain a valid HAR 1.2 document")
	}
	return nil
}
