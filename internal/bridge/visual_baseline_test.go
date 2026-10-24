package bridge

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"strings"
	"testing"
	"time"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

func visualTestFrame(t *testing.T, width, height int) (protocol.VisualCaptureFrame, *image.NRGBA) {
	t.Helper()
	pixels := image.NewNRGBA(image.Rect(0, 0, width, height))
	frame := protocol.VisualCaptureFrame{CapturedAt: time.Now().UTC().Format(time.RFC3339Nano), Scope: protocol.VisualFrameScope{TabId: 42, WindowId: 7, DocumentId: "document-one", Rect: protocol.VisualRect{X: 10, Y: 20, Width: float64(width), Height: float64(height)}, ViewportWidth: float64(width + 20), ViewportHeight: float64(height + 40), DevicePixelRatio: 2, ViewportScale: 1, VisualViewportWidth: float64(width + 20), VisualViewportHeight: float64(height + 40)}, Contexts: []protocol.VisualRect{}}
	return frame, pixels
}

func visualTestResponse(t *testing.T, id string, frame protocol.VisualCaptureFrame, pixels *image.NRGBA) object {
	t.Helper()
	evidence, _, err := visualEvidence(pixels, pixels.Bounds(), "after")
	if err != nil {
		t.Fatal(err)
	}
	frame.Image = evidence.Image
	return success(id, objectFromVisual(frame))
}

func TestVisualComparisonExactPixelsContextAndCoordinates(t *testing.T) {
	frame, before := visualTestFrame(t, 1000, 700)
	_, after := visualTestFrame(t, 1000, 700)
	// A one-level change must survive. Thresholding previously missed real evidence.
	after.SetNRGBA(510, 220, color.NRGBA{R: 1, A: 255})
	frame.Contexts = []protocol.VisualRect{{X: 410, Y: 120, Width: 260, Height: 260}}
	baseline := &visualBaseline{frame: frame, pixels: before}
	result, err := compareVisual(baseline, frame, after, visualCompareOptions{includeBefore: true})
	if err != nil || result.Strategy != "crop" || result.Equal.Value || result.ChangedPixels.Value != 1 || len(result.Images) != 2 {
		t.Fatalf("comparison: %+v %v", result, err)
	}
	for i, evidence := range result.Images {
		if evidence.Rect.X > 400 || evidence.Rect.Y > 100 || evidence.Rect.X+evidence.Rect.Width < 660 || evidence.Rect.Y+evidence.Rect.Height < 360 {
			t.Fatalf("component context clipped: %+v", evidence.Rect)
		}
		capture := frame
		capture.Image = evidence.Image
		_, decoded, err := decodeVisualFrame(value(capture))
		if err != nil {
			t.Fatal(err)
		}
		if decoded.Bounds().Dx() != int(evidence.Rect.Width) {
			t.Fatal("crop size and original coordinates disagree")
		}
		if i == 1 && decoded.NRGBAAt(510-int(evidence.Rect.X), 220-int(evidence.Rect.Y)) != after.NRGBAAt(510, 220) {
			t.Fatal("crop did not preserve changed pixels")
		}
	}
	unchanged, err := compareVisual(baseline, frame, before, visualCompareOptions{includeBefore: true})
	if err != nil || !unchanged.Equal.Valid || !unchanged.Equal.Value || len(unchanged.Images) != 0 || unchanged.Strategy != "none" {
		t.Fatal("unchanged must return no images")
	}
	currentOnly, err := compareVisual(baseline, frame, after, visualCompareOptions{})
	if err != nil || len(currentOnly.Images) != 1 || currentOnly.Images[0].Phase != "after" {
		t.Fatal("after-only option ignored")
	}
}

func TestVisualComparisonDPRGeometryAndFullFallback(t *testing.T) {
	frame, before := visualTestFrame(t, 800, 600)
	_, after := visualTestFrame(t, 800, 600)
	after.SetNRGBA(0, 0, color.NRGBA{A: 255})
	after.SetNRGBA(799, 599, color.NRGBA{A: 255})
	baseline := &visualBaseline{frame: frame, pixels: before}
	result, err := compareVisual(baseline, frame, after, visualCompareOptions{includeBefore: true})
	if err != nil || result.Status != "diff_not_useful" || result.Reason != "changes_too_spread_out" || !result.Comparable || len(result.Images) != 0 || result.ChangedPixels.Value != 2 || !result.ChangedRect.Valid {
		t.Fatal("scattered changes must return exact metadata without images")
	}
	result, err = compareVisual(baseline, frame, after, visualCompareOptions{includeBefore: true, fallbackCurrent: true})
	if err != nil || result.Status != "diff_not_useful" || result.Strategy != "full" || len(result.Images) != 1 || result.Images[0].Phase != "after" {
		t.Fatal("explicit fallback must return only one current image")
	}
	frame.Scope.ScrollY = 180
	result, err = compareVisual(baseline, frame, after, visualCompareOptions{includeBefore: true})
	if err != nil || result.Status != "not_comparable" || result.Comparable || result.Equal.Valid || !result.RequiresNewBaseline || len(result.Images) != 0 {
		t.Fatal("scroll was falsely compared")
	}
	result, err = compareVisual(baseline, frame, after, visualCompareOptions{includeBefore: true, fallbackCurrent: true})
	if err != nil || result.Comparable || result.Equal.Valid || len(result.Images) != 1 || result.Images[0].Phase != "after" {
		t.Fatal("geometry fallback cannot imply a meaningful diff or include before pixels")
	}
	// Crop-to-CSS mapping uses actual image dimensions, not display DPR assumptions.
	frame.Scope = baseline.frame.Scope
	frame.Scope.VisualViewportX = 10
	result, err = compareVisual(baseline, frame, after, visualCompareOptions{includeBefore: true})
	if err != nil || result.Comparable || !result.RequiresNewBaseline {
		t.Fatal("pinch viewport panning was falsely compared")
	}
	frame.Scope = baseline.frame.Scope
	frame.Scope.Rect.Width, frame.Scope.Rect.Height = 400, 300
	frame.Contexts = []protocol.VisualRect{{X: 110, Y: 120, Width: 100, Height: 80}}
	box := visualContextRect(image.Rect(210, 210, 211, 211), before.Bounds(), frame)
	if !image.Pt(200, 200).In(box) || !image.Pt(399, 359).In(box) {
		t.Fatalf("DPR mapping clipped component: %v", box)
	}
}

func TestVisualDenseAndContextHeavyDiffsAreImageFree(t *testing.T) {
	frame, before := visualTestFrame(t, 800, 600)
	_, after := visualTestFrame(t, 800, 600)
	for y := 0; y < 210; y++ {
		for x := 0; x < 800; x++ {
			after.SetNRGBA(x, y, color.NRGBA{A: 255})
		}
	}
	baseline := &visualBaseline{frame: frame, pixels: before}
	result, err := compareVisual(baseline, frame, after, visualCompareOptions{})
	if err != nil || result.Status != "diff_not_useful" || result.Reason != "too_different" || result.Equal.Value || result.ChangedPixels.Value != 168000 || result.ChangedPixelRatio.Value != 0.35 || len(result.Images) != 0 {
		t.Fatalf("dense change must return an exact, image-free observation: %+v %v", result, err)
	}
	after.SetNRGBA(799, 209, color.NRGBA{})
	result, err = compareVisual(baseline, frame, after, visualCompareOptions{})
	if err != nil || result.Status != "changed" || result.ChangedPixels.Value != 167999 || len(result.Images) != 1 {
		t.Fatal("density limit must not erase exact differences below its boundary")
	}
	frame, before = visualTestFrame(t, 1000, 700)
	_, after = visualTestFrame(t, 1000, 700)
	after.SetNRGBA(500, 300, color.NRGBA{A: 255})
	frame.Contexts = []protocol.VisualRect{frame.Scope.Rect}
	baseline = &visualBaseline{frame: frame, pixels: before}
	result, err = compareVisual(baseline, frame, after, visualCompareOptions{includeBefore: true})
	if err != nil || result.Reason != "context_too_large" || result.ChangedPixels.Value != 1 || result.CropAreaRatio.Value != 1 || len(result.Images) != 0 {
		t.Fatal("context-heavy tiny change was mislabeled or sent as full images")
	}
}

func TestVisualEvidenceBudgetSuppressesPairsInsteadOfFailing(t *testing.T) {
	frame, before := visualTestFrame(t, 2000, 2000)
	_, after := visualTestFrame(t, 2000, 2000)
	// Opaque RGB screenshots compress like Chrome output; only the local patch is noisy.
	for i := 3; i < len(before.Pix); i += 4 {
		before.Pix[i], after.Pix[i] = 255, 255
	}
	state := uint32(1327)
	for y := 300; y < 650; y++ {
		for x := 300; x < 650; x++ {
			var rgb [3]uint8
			for channel := range rgb {
				state ^= state << 13
				state ^= state >> 17
				state ^= state << 5
				rgb[channel] = uint8(state)
			}
			before.SetNRGBA(x, y, color.NRGBA{R: rgb[0], G: rgb[1], B: rgb[2], A: 255})
			after.SetNRGBA(x, y, color.NRGBA{R: ^rgb[0], G: ^rgb[1], B: ^rgb[2], A: 255})
		}
	}
	baseline := &visualBaseline{frame: frame, pixels: before}
	result, err := compareVisual(baseline, frame, after, visualCompareOptions{includeBefore: true})
	if err != nil || result.Reason != "evidence_too_large" || result.Status != "diff_not_useful" || result.ChangedPixels.Value != 122500 || len(result.Images) != 0 {
		t.Fatalf("oversized pair must be a compact successful result, not an error: %+v %v", result, err)
	}
	result, err = compareVisual(baseline, frame, after, visualCompareOptions{includeBefore: true, fallbackCurrent: true})
	if err != nil || result.Strategy != "full" || len(result.Images) != 1 || result.Images[0].Phase != "after" {
		t.Fatalf("explicit fallback must not repeat the oversized pair: %+v %v", result, err)
	}
}

func TestVisualSuppressedDiffRetainsReferenceUntilExplicitFallback(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	frame, before := visualTestFrame(t, 800, 600)
	key := "visual_" + strings.Repeat("d", 32)
	baseline := &visualBaseline{target: extension, frame: frame, pixels: before, params: object{"selector": value("#card")}, expires: time.Now().Add(time.Minute)}
	d.baselines.visual[key] = baseline
	_, after := visualTestFrame(t, 800, 600)
	after.SetNRGBA(0, 0, color.NRGBA{A: 255})
	after.SetNRGBA(799, 599, color.NRGBA{A: 255})
	compare := func(params object) object {
		d.route(agent, newRequest("screenshot.baseline.compare", params, nil, 42))
		request := serviceNextMessage(t, extension).object("request")
		if request.object("params").text("selector") != "#card" || request.object("params")["fallback"] != nil {
			t.Fatal("fallback options leaked into renderer capture scope")
		}
		d.response(extension, visualTestResponse(t, request.text("id"), frame, after))
		response := serviceNextMessage(t, agent).object("response")
		if !response.boolean("ok") {
			t.Fatalf("compare failed: %s", value(response))
		}
		return response.object("result")
	}
	result := compare(object{"baselineId": value(key), "advance": value(true)})
	if result.text("status") != "diff_not_useful" || result.boolean("advanced") || d.baselines.visual[key] != baseline || !bytes.Equal(result["images"], []byte("[]")) {
		t.Fatal("suppressed evidence advanced or lost the before-state")
	}
	mcp := mcpResponse(success("suppressed", result), "screenshot.baseline.compare", nil)
	if mcp.boolean("isError") || bytes.Contains(mcp["content"], []byte(`"type":"image"`)) {
		t.Fatal("compact observation was turned into an error or image")
	}
	result = compare(object{"baselineId": value(key), "advance": value(true), "fallback": value("current")})
	images, _ := cliArray(result["images"])
	if !result.boolean("advanced") || len(images) != 1 || cliRecord(images[0]).text("phase") != "after" || !d.baselines.visual[key].expires.Equal(baseline.expires) {
		t.Fatal("explicit current evidence did not advance safely with original expiry")
	}
	result = compare(object{"baselineId": value(key)})
	if !result.boolean("equal") || result.text("status") != "unchanged" {
		t.Fatal("reference did not advance to the observed current frame")
	}
	for _, fallback := range []json.RawMessage{value("always"), value(1), value[*string](nil)} {
		d.route(agent, newRequest("screenshot.baseline.compare", object{"baselineId": value(key), "fallback": fallback}, nil, 42))
		if serviceNextMessage(t, agent).object("response").object("error").text("code") != "INVALID_REQUEST" {
			t.Fatal("invalid fallback was silently accepted")
		}
	}
}

func TestVisualDaemonLifecycleAndSeries(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	foreign := serviceTestPeer(t, d, "extension")
	frame, before := visualTestFrame(t, 900, 650)
	d.route(agent, newRequest("screenshot.baseline.create", object{"selector": value("#card")}, object{"target_extension": value(extension.id)}, 42))
	request := serviceNextMessage(t, extension).object("request")
	d.response(extension, visualTestResponse(t, request.text("id"), frame, before))
	created := serviceNextMessage(t, agent).object("response")
	key := created.object("result").text("baselineId")
	if !created.boolean("ok") || !visualIDPattern.MatchString(key) || bytes.Contains(created["result"], []byte("base64")) {
		t.Fatalf("baseline metadata: %s", value(created))
	}
	reader := serviceTestPeer(t, d, "agent")
	params := object{"baselineId": value(key), "advance": value(true)}
	d.route(reader, newRequest("screenshot.baseline.compare", params, nil, 42))
	request = serviceNextMessage(t, extension).object("request")
	if request.object("params").text("selector") != "#card" || request.number("tab_id") != 42 || len(foreign.out) != 0 {
		t.Fatal("baseline did not preserve exact destination/scope")
	}
	_, after := visualTestFrame(t, 900, 650)
	after.SetNRGBA(450, 200, color.NRGBA{A: 255})
	d.response(foreign, visualTestResponse(t, request.text("id"), frame, after))
	if len(reader.out) != 0 {
		t.Fatal("foreign extension answered comparison")
	}
	d.response(extension, visualTestResponse(t, request.text("id"), frame, after))
	result := serviceNextMessage(t, reader).object("response").object("result")
	if !result.boolean("advanced") || result.boolean("equal") {
		t.Fatal("explicit advance failed")
	}
	expiry := d.baselines.visual[key].expires
	d.route(reader, newRequest("screenshot.baseline.compare", object{"baselineId": value(key)}, nil, 0))
	request = serviceNextMessage(t, extension).object("request")
	d.response(extension, visualTestResponse(t, request.text("id"), frame, after))
	result = serviceNextMessage(t, reader).object("response").object("result")
	if !result.boolean("equal") || !d.baselines.visual[key].expires.Equal(expiry) {
		t.Fatal("adjacent frame advanced incorrectly or extended expiry")
	}
	d.route(reader, newRequest("screenshot.baseline.compare", params, object{"target_extension": value(foreign.id)}, 42))
	if serviceNextMessage(t, reader).object("response").object("error").text("code") != "VISUAL_BASELINE_NOT_FOUND" {
		t.Fatal("wrong destination accepted")
	}
	d.route(reader, newRequest("screenshot.baseline.compare", params, nil, 43))
	if serviceNextMessage(t, reader).object("response").object("error").text("code") != "TAB_MISMATCH" {
		t.Fatal("wrong tab accepted")
	}
	d.route(reader, newRequest("screenshot.baseline.release", params, nil, 42))
	if !serviceNextMessage(t, reader).object("response").object("result").boolean("released") {
		t.Fatal("release failed")
	}
	d.route(reader, newRequest("screenshot.baseline.release", params, nil, 42))
	if serviceNextMessage(t, reader).object("response").object("result").boolean("released") {
		t.Fatal("release not idempotent")
	}
}

func TestVisualLifecycleExpiryQuotaInvalidationAndUndelivered(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	frame, pixels := visualTestFrame(t, 100, 100)
	create := func() object {
		d.route(agent, newRequest("screenshot.baseline.create", object{"rect": value(frame.Scope.Rect)}, nil, 42))
		request := serviceNextMessage(t, extension).object("request")
		d.response(extension, visualTestResponse(t, request.text("id"), frame, pixels))
		return serviceNextMessage(t, agent).object("response")
	}
	first := create().object("result").text("baselineId")
	second := create().object("result").text("baselineId")
	if create().object("error").text("code") != "VISUAL_BASELINE_QUOTA_EXCEEDED" {
		t.Fatal("per-tab quota not enforced")
	}
	d.baselines.visual[second].expires = time.Now().Add(-time.Second)
	d.baselines.prune()
	if d.baselines.visual[second] != nil {
		t.Fatal("expired pixels retained")
	}
	d.route(agent, newRequest("screenshot.baseline.compare", object{"baselineId": value(first)}, nil, 42))
	request := serviceNextMessage(t, extension).object("request")
	frame.Scope.DocumentId = "new-document"
	d.response(extension, visualTestResponse(t, request.text("id"), frame, pixels))
	if serviceNextMessage(t, agent).object("response").object("error").text("code") != "VISUAL_BASELINE_INVALIDATED" || len(d.baselines.visual) != 0 {
		t.Fatal("navigation retained baseline")
	}
	d.route(agent, newRequest("screenshot.baseline.create", object{"selector": value("#card")}, nil, 42))
	request = serviceNextMessage(t, extension).object("request")
	d.response(extension, visualTestResponse(t, request.text("id"), frame, pixels))
	queued := <-agent.out
	agent.queuedBytes.Add(-queued.bytes)
	if queued.onWrite == nil {
		t.Fatal("visual create delivery not tracked")
	}
	queued.onWrite(false)
	if len(d.baselines.visual) != 0 {
		t.Fatal("undelivered handle retained pixels")
	}
	_ = create()
	d.baselines.clear(extension)
	if len(d.baselines.visual) != 0 {
		t.Fatal("revocation retained visual pixels")
	}
}

func TestVisualMalformedInputsAndMCPImages(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	_ = serviceTestPeer(t, d, "extension")
	for _, params := range []object{{}, {"selector": value("")}, {"selector": value("#card"), "rect": value(object{})}, {"rect": value(object{"width": value(-1)})}} {
		d.route(agent, newRequest("screenshot.baseline.create", params, nil, 42))
		if serviceNextMessage(t, agent).object("response").object("error").text("code") != "INVALID_REQUEST" {
			t.Fatal("malformed create accepted")
		}
	}
	frame, pixels := visualTestFrame(t, 20, 20)
	evidence, _, err := visualEvidence(pixels, pixels.Bounds(), "before")
	if err != nil {
		t.Fatal(err)
	}
	frame.Image = "data:image/png;base64,not-valid"
	if _, _, err := decodeVisualFrame(value(frame)); err == nil {
		t.Fatal("invalid image accepted")
	}
	result := object{"baselineId": value("visual_" + strings.Repeat("a", 32)), "reason": value("localized_change"), "images": value([]protocol.VisualEvidenceImage{evidence}), "guidance": value("Inspect context.")}
	response := success("test", result)
	mcp := mcpResponse(response, "screenshot.baseline.compare", nil)
	if mcp.boolean("isError") || bytes.Contains(mcp["structuredContent"], []byte("base64")) {
		t.Fatal("image data leaked into structured text")
	}
	var content []object
	if json.Unmarshal(mcp["content"], &content) != nil || len(content) != 3 || content[2].text("type") != "image" {
		t.Fatalf("MCP image blocks missing: %s", value(mcp))
	}
	if bytes.Contains(cliSummaryNow(response, "screenshot.baseline.compare")["evidence"], []byte("base64")) {
		t.Fatal("CLI summary leaked image data")
	}
}

func TestVisualPendingRevocationCancellationAndRevision(t *testing.T) {
	for _, action := range []string{"revoke", "cancel", "release", "advance"} {
		t.Run(action, func(t *testing.T) {
			d := serviceTestDaemon(t)
			agent := serviceTestPeer(t, d, "agent")
			extension := serviceTestPeer(t, d, "extension")
			frame, pixels := visualTestFrame(t, 40, 40)
			key := "visual_" + strings.Repeat("c", 32)
			baseline := &visualBaseline{target: extension, frame: frame, pixels: pixels, params: object{"selector": value("#card")}, expires: time.Now().Add(time.Minute)}
			d.baselines.visual[key] = baseline
			d.route(agent, newRequest("screenshot.baseline.compare", object{"baselineId": value(key)}, nil, 42))
			request := serviceNextMessage(t, extension).object("request")
			switch action {
			case "cancel":
				d.disconnect(agent)
			case "revoke":
				d.baselines.clear(extension)
				// Even if enabled again before decoding finishes, the old grant cannot expose pixels.
				extension.access = true
			case "release":
				delete(d.baselines.visual, key)
			default:
				updated := *baseline
				d.baselines.visual[key] = &updated
			}
			d.response(extension, visualTestResponse(t, request.text("id"), frame, pixels))
			if action == "cancel" {
				if len(agent.out) != 0 {
					t.Fatal("canceled client received pixels")
				}
				return
			}
			response := serviceNextMessage(t, agent).object("response")
			if response.boolean("ok") || bytes.Contains(response["result"], []byte("base64")) {
				t.Fatal("stale pending response exposed visual evidence")
			}
		})
	}
}

func TestVisualDiscoveryRemainsExplicitAndSequential(t *testing.T) {
	for _, method := range []string{"screenshot.baseline.create", "screenshot.baseline.compare", "screenshot.baseline.release"} {
		description := describe(object{"method": value(method)})
		if description.object("inputSchema").text("type") != "object" || description.object("example") == nil {
			t.Fatalf("missing generated input schema/example for %s", method)
		}
		if batchSafe(method, nil) {
			t.Fatalf("stateful visual method is batch-safe: %s", method)
		}
		if artifactKind(method) != "" {
			t.Fatalf("memory-only visual method accepted disk artifacts: %s", method)
		}
	}
	found := false
	for _, tool := range catalog.Tools {
		if tool.text("name") == "browser_call" {
			found = strings.Contains(tool.text("description"), "Only when DOM diffs") && strings.Contains(tool.text("description"), "screenshot.baseline.create/compare/release")
		}
	}
	if !found {
		t.Fatal("compact MCP tool must explain when to opt into visual baselines")
	}
}

func TestVisualNavigationSignalClearsOnlyOwnedTabAndCancelsPendingCapture(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	foreign := serviceTestPeer(t, d, "extension")
	frame, pixels := visualTestFrame(t, 40, 40)
	for _, key := range []string{"visual_" + strings.Repeat("1", 32), "visual_" + strings.Repeat("2", 32)} {
		d.baselines.visual[key] = &visualBaseline{target: extension, frame: frame, pixels: pixels, params: object{"selector": value("#card")}, expires: time.Now().Add(time.Minute)}
	}
	other := d.baselines.visual["visual_"+strings.Repeat("2", 32)]
	other.frame.Scope.TabId = 43
	message := nativeToDaemon(object{"type": value("host.visual_baseline_invalidated"), "tabId": value(42)})
	if message.text("type") != "extension.visual_baseline_invalidated" {
		t.Fatal("native relay lost lifecycle notification")
	}
	d.handle(foreign, message)
	if len(d.baselines.visual) != 2 {
		t.Fatal("foreign profile invalidated owned pixels")
	}
	d.route(agent, newRequest("screenshot.baseline.create", object{"selector": value("#card")}, object{"target_extension": value(extension.id)}, 42))
	request := serviceNextMessage(t, extension).object("request")
	d.handle(extension, message)
	if len(d.baselines.visual) != 1 || d.baselines.visual["visual_"+strings.Repeat("2", 32)] != other {
		t.Fatal("lifecycle signal did not isolate tab cleanup")
	}
	if serviceNextMessage(t, extension).text("type") != "extension.request_cancelled" {
		t.Fatal("navigation failed to cancel capture")
	}
	if serviceNextMessage(t, agent).object("response").object("error").text("code") != "VISUAL_BASELINE_INVALIDATED" {
		t.Fatal("navigation returned misleading evidence")
	}
	d.response(extension, visualTestResponse(t, request.text("id"), frame, pixels))
	if len(agent.out) != 0 || len(d.baselines.visual) != 1 {
		t.Fatal("late renderer response revived cleared pixels")
	}
}

func BenchmarkVisualChanges(b *testing.B) {
	for _, size := range []struct {
		name          string
		width, height int
	}{{"1280x800", 1280, 800}, {"1920x1080", 1920, 1080}} {
		b.Run(size.name, func(b *testing.B) {
			before := image.NewNRGBA(image.Rect(0, 0, size.width, size.height))
			after := image.NewNRGBA(before.Bounds())
			after.SetNRGBA(500, 200, color.NRGBA{A: 255})
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_, count := visualChanges(before, after)
				if count != 1 {
					b.Fatal("incorrect changed pixel count")
				}
			}
		})
	}
}
