package bridge

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/draw"
	"image/png"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

var visualIDPattern = regexp.MustCompile(`^visual_[a-f0-9]{32}$`)

type visualBaseline struct {
	target  *peer
	frame   protocol.VisualCaptureFrame
	pixels  *image.NRGBA
	params  object
	created time.Time
	expires time.Time
}

func isVisualBaseline(method string) bool { return strings.HasPrefix(method, "screenshot.baseline.") }

// Called under daemon.mu. Handles are secret capabilities, bound to one browser and tab,
// and work across short-lived CLI connections just like semantic DOM baselines.
func (d *daemon) prepareVisualRequest(p *peer, request, params object, candidates []*peer) ([]*peer, bool) {
	id, method := request.text("id"), request.text("method")
	if method == "screenshot.baseline.create" {
		var input protocol.VisualBaselineCreateParams
		if json.Unmarshal(value(params), &input) != nil || input.Selector.Set == input.Rect.Set ||
			(input.Selector.Set && !validText(input.Selector.Value, 512)) ||
			(input.Rect.Set && !validVisualRect(input.Rect.Value)) {
			d.localResponse(p, request, failure(id, "INVALID_REQUEST", "Choose exactly one selector or finite, positive viewport rect."))
			return nil, true
		}
		// Retain canonical capture options, not arbitrary caller fields or oversized extras.
		for key := range params {
			delete(params, key)
		}
		if input.Selector.Set {
			params["selector"] = value(input.Selector.Value)
		} else {
			rect := input.Rect.Value
			rect.Extra = nil
			params["rect"] = value(rect)
		}
		return candidates, false
	}
	var input protocol.VisualBaselineCompareParams
	if json.Unmarshal(value(params), &input) != nil || !visualIDPattern.MatchString(input.BaselineId) {
		d.localResponse(p, request, failure(id, "INVALID_REQUEST", "Invalid visual baseline parameters."))
		return nil, true
	}
	d.baselines.prune()
	baseline := d.baselines.visual[input.BaselineId]
	matching := []*peer{}
	for _, target := range candidates {
		if baseline != nil && baseline.target == target && target.access {
			matching = append(matching, target)
		}
	}
	if len(matching) == 0 {
		response := failure(id, "VISUAL_BASELINE_NOT_FOUND", "Visual baseline is missing, expired, released, or browser access ended.")
		if method == "screenshot.baseline.release" {
			response = success(id, object{"baselineId": value(input.BaselineId), "released": value(false)})
		}
		d.localResponse(p, request, response)
		return nil, true
	}
	if tab := request.number("tab_id"); tab != 0 && float64(tab) != baseline.frame.Scope.TabId {
		d.localResponse(p, request, failure(id, "TAB_MISMATCH", "Visual baseline belongs to a different tab."))
		return nil, true
	}
	if method == "screenshot.baseline.release" {
		delete(d.baselines.visual, input.BaselineId)
		d.localResponse(p, request, success(id, object{"baselineId": value(input.BaselineId), "released": value(true)}))
		return nil, true
	}
	request["tab_id"] = value(baseline.frame.Scope.TabId)
	return matching, false
}

func validVisualRect(r protocol.VisualRect) bool {
	return r.X >= 0 && r.Y >= 0 && r.Width >= 1 && r.Height >= 1 &&
		r.X+r.Width <= 16384 && r.Y+r.Height <= 16384 &&
		!math.IsNaN(r.X+r.Y+r.Width+r.Height) && !math.IsInf(r.X+r.Y+r.Width+r.Height, 0)
}

func decodeVisualFrame(raw json.RawMessage) (protocol.VisualCaptureFrame, *image.NRGBA, error) {
	var frame protocol.VisualCaptureFrame
	if json.Unmarshal(raw, &frame) != nil || frame.Scope.DocumentId == "" || len(frame.Scope.DocumentId) > 128 ||
		frame.Scope.TabId <= 0 || frame.Scope.WindowId <= 0 || !validVisualRect(frame.Scope.Rect) ||
		frame.Scope.ViewportWidth < 1 || frame.Scope.ViewportHeight < 1 || frame.Scope.VisualViewportWidth < 1 || frame.Scope.VisualViewportHeight < 1 || frame.Scope.DevicePixelRatio <= 0 || frame.Scope.ViewportScale <= 0 || len(frame.Contexts) > 128 {
		return frame, nil, errors.New("invalid visual frame scope")
	}
	if _, err := time.Parse(time.RFC3339Nano, frame.CapturedAt); err != nil || len(frame.CapturedAt) > 64 {
		return frame, nil, errors.New("invalid visual capture timestamp")
	}
	if frame.Scope.Rect.X+frame.Scope.Rect.Width > frame.Scope.ViewportWidth || frame.Scope.Rect.Y+frame.Scope.Rect.Height > frame.Scope.ViewportHeight {
		return frame, nil, errors.New("visual capture is outside the viewport")
	}
	for _, context := range frame.Contexts {
		for _, coordinate := range []float64{context.X, context.Y, context.Width, context.Height} {
			if math.IsNaN(coordinate) || math.IsInf(coordinate, 0) || math.Abs(coordinate) > 10_000_000 {
				return frame, nil, errors.New("invalid visual context rectangle")
			}
		}
	}
	// Retain only canonical evidence fields, never arbitrary renderer metadata.
	frame.Extra, frame.Scope.Extra, frame.Scope.Rect.Extra = nil, nil, nil
	for i := range frame.Contexts {
		frame.Contexts[i].Extra = nil
	}
	data, err := base64.StdEncoding.Strict().DecodeString(strings.TrimPrefix(frame.Image, "data:image/png;base64,"))
	if err != nil || !strings.HasPrefix(frame.Image, "data:image/png;base64,") || len(data) > protocol.ScreenshotMaxInlineBytes {
		return frame, nil, errors.New("invalid or oversized visual PNG")
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > protocol.MaxVisualBaselinePixels/config.Height {
		return frame, nil, errors.New("visual PNG exceeds pixel limit")
	}
	decoded, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return frame, nil, err
	}
	pixels := image.NewNRGBA(decoded.Bounds())
	draw.Draw(pixels, pixels.Bounds(), decoded, decoded.Bounds().Min, draw.Src)
	frame.Image = "" // Do not retain a second base64 copy of the screenshot.
	return frame, pixels, nil
}

func visualEvidence(pixels *image.NRGBA, rect image.Rectangle, phase string) (protocol.VisualEvidenceImage, int, error) {
	var out bytes.Buffer
	if err := png.Encode(&out, pixels.SubImage(rect)); err != nil {
		return protocol.VisualEvidenceImage{}, 0, err
	}
	return protocol.VisualEvidenceImage{Phase: phase, Image: "data:image/png;base64," + base64.StdEncoding.EncodeToString(out.Bytes()), Rect: protocol.VisualRect{X: float64(rect.Min.X), Y: float64(rect.Min.Y), Width: float64(rect.Dx()), Height: float64(rect.Dy())}}, out.Len(), nil
}

// Exact comparison deliberately has no perceptual threshold or small-component filter.
func visualChanges(before, after *image.NRGBA) (image.Rectangle, int) {
	bounds := after.Bounds()
	changed := image.Rectangle{}
	count := 0
	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x++ {
			i, j := before.PixOffset(x, y), after.PixOffset(x, y)
			if before.Pix[i] == after.Pix[j] && before.Pix[i+1] == after.Pix[j+1] && before.Pix[i+2] == after.Pix[j+2] && before.Pix[i+3] == after.Pix[j+3] {
				continue
			}
			count++
			changed = changed.Union(image.Rect(x, y, x+1, y+1))
		}
	}
	return changed, count
}

// Expand from actual changed pixels into whole semantic boxes in BOTH frames.
// Use a single union to avoid per-image overhead and clipped inter-region relationships.
func visualContextRect(changed, bounds image.Rectangle, frames ...protocol.VisualCaptureFrame) image.Rectangle {
	result := changed.Inset(-64).Intersect(bounds)
	for _, frame := range frames {
		sx, sy := float64(bounds.Dx())/frame.Scope.Rect.Width, float64(bounds.Dy())/frame.Scope.Rect.Height
		for _, context := range frame.Contexts {
			if context.Width <= 0 || context.Height <= 0 {
				continue
			}
			r := image.Rect(int(math.Floor((context.X-frame.Scope.Rect.X)*sx)), int(math.Floor((context.Y-frame.Scope.Rect.Y)*sy)), int(math.Ceil((context.X+context.Width-frame.Scope.Rect.X)*sx)), int(math.Ceil((context.Y+context.Height-frame.Scope.Rect.Y)*sy))).Intersect(bounds)
			if !r.Intersect(changed).Empty() {
				result = result.Union(r)
			}
		}
	}
	// Minimum surrounding evidence instead of nearly context-free one-pixel/text slivers.
	for result.Dx() < min(256, bounds.Dx()) || result.Dy() < min(192, bounds.Dy()) {
		result = result.Inset(-16).Intersect(bounds)
	}
	return result
}

func compareVisual(baseline *visualBaseline, frame protocol.VisualCaptureFrame, pixels *image.NRGBA, includeBefore bool) (protocol.VisualBaselineCompareResult, error) {
	bounds := pixels.Bounds()
	result := protocol.VisualBaselineCompareResult{BeforeScope: baseline.frame.Scope, AfterScope: frame.Scope, Dimensions: protocol.VisualBaselineCompareResultDimensions{Width: float64(bounds.Dx()), Height: float64(bounds.Dy())}, Images: []protocol.VisualEvidenceImage{}, Strategy: "none", Reason: "unchanged", Guidance: "Visual evidence is not proof of action success. Inspect application postconditions. Crops may omit context; use a complete scoped screenshot when meaning is unclear."}
	result.Comparable = bytes.Equal(value(baseline.frame.Scope), value(frame.Scope)) && baseline.pixels.Bounds() == bounds
	if !result.Comparable {
		result.Strategy, result.Reason, result.RequiresNewBaseline = "full", "capture_geometry_changed", true
		includeBefore = false // Different coordinate frames must not be presented as a pixel comparison.
	} else {
		changed, count := visualChanges(baseline.pixels, pixels)
		result.Equal = protocol.Nullable[bool]{Value: count == 0, Valid: true}
		result.ChangedPixels = protocol.Nullable[float64]{Value: float64(count), Valid: true}
		result.ChangedPixelRatio = protocol.Nullable[float64]{Value: float64(count) / float64(bounds.Dx()*bounds.Dy()), Valid: true}
		if count == 0 {
			return result, nil
		}
		crop := visualContextRect(changed, bounds, baseline.frame, frame)
		factor := 1
		if includeBefore {
			factor = 2
		}
		if crop.Dx()*crop.Dy()*factor < bounds.Dx()*bounds.Dy()/2 {
			result.Strategy, result.Reason = "crop", "localized_change"
			bounds = crop
		} else {
			result.Strategy, result.Reason = "full", "context_or_change_too_large"
		}
	}
	encodedBytes := 0
	if includeBefore {
		before, size, err := visualEvidence(baseline.pixels, bounds, "before")
		if err != nil {
			return result, err
		}
		result.Images, encodedBytes = append(result.Images, before), size
	}
	after, size, err := visualEvidence(pixels, bounds, "after")
	if err != nil {
		return result, err
	}
	if encodedBytes+size > protocol.ScreenshotMaxInlineBytes {
		return result, errors.New("visual evidence exceeds inline limit; narrow the scope or set includeBefore=false")
	}
	result.Images = append(result.Images, after)
	return result, nil
}

// Decode/scan/encode outside daemon.mu on the bounded serial worker, then revalidate
// access, expiry, pending identity and baseline revision before exposing any pixels.
func (d *daemon) visualResponse(p *peer, pending *pendingRequest, response object) {
	id := response.text("id")
	baseline := pending.visual
	if !d.store(len(response["result"]), false, func() func() {
		frame, pixels, err := decodeVisualFrame(response["result"])
		var compared protocol.VisualBaselineCompareResult
		if err == nil && baseline != nil && frame.Scope.DocumentId == baseline.frame.Scope.DocumentId {
			compared, err = compareVisual(baseline, frame, pixels, pending.params["includeBefore"] == nil || pending.params.boolean("includeBefore"))
		}
		return func() {
			if d.pending[id] != pending {
				return
			}
			if pending.localError != nil {
				d.finish(id, pending.localError)
				return
			}
			if !d.peers[p] || !p.access || p.accessEpoch != pending.visualEpoch {
				d.finish(id, failure(id, "ACCESS_DENIED", "Visual capture access ended."))
				return
			}
			if err != nil {
				d.finish(id, failure(id, "RESULT_TOO_LARGE", err.Error()))
				return
			}
			if pending.requestedTab != 0 && frame.Scope.TabId != float64(pending.requestedTab) {
				d.finish(id, failure(id, "TAB_MISMATCH", "Visual capture returned a different tab."))
				return
			}
			d.baselines.prune()
			if baseline == nil {
				retained := 0
				perTab := 0
				for _, existing := range d.baselines.visual {
					retained += len(existing.pixels.Pix)
					if existing.target == p && existing.frame.Scope.TabId == frame.Scope.TabId {
						perTab++
					}
				}
				if len(d.baselines.visual) >= protocol.MaxVisualBaselinesGlobal || perTab >= protocol.MaxVisualBaselinesPerTab || retained+len(pixels.Pix) > protocol.MaxVisualBaselineBytesGlobal {
					d.finish(id, failure(id, "VISUAL_BASELINE_QUOTA_EXCEEDED", "Release an unused visual baseline or narrow the scope."))
					return
				}
				created := time.Now().UTC()
				key := "visual_" + strings.ReplaceAll(uniqueID(), "-", "")
				expires := created.Add(time.Duration(protocol.VisualBaselineTTLMS) * time.Millisecond)
				d.baselines.visual[key] = &visualBaseline{target: p, frame: frame, pixels: pixels, params: pending.params, created: created, expires: expires}
				descriptor := protocol.VisualBaselineDescriptor{BaselineId: key, CreatedAt: created.Format(time.RFC3339Nano), ExpiresAt: expires.Format(time.RFC3339Nano), Scope: frame.Scope, Dimensions: protocol.VisualBaselineDescriptorDimensions{Width: float64(pixels.Bounds().Dx()), Height: float64(pixels.Bounds().Dy())}}
				d.finish(id, success(id, objectFromVisual(descriptor)))
				return
			}
			if d.baselines.visual[pending.baselineID] != baseline {
				d.finish(id, failure(id, "VISUAL_BASELINE_INVALIDATED", "Visual baseline expired, was released, or advanced during comparison."))
				return
			}
			if baseline.frame.Scope.DocumentId != frame.Scope.DocumentId {
				delete(d.baselines.visual, pending.baselineID)
				d.finish(id, failure(id, "VISUAL_BASELINE_INVALIDATED", "Visual baseline belongs to a different document."))
				return
			}
			compared.BaselineId = pending.baselineID
			if compared.RequiresNewBaseline {
				delete(d.baselines.visual, pending.baselineID)
			} else if pending.params.boolean("advance") {
				updated := *baseline
				updated.frame, updated.pixels = frame, pixels
				d.baselines.visual[pending.baselineID] = &updated
				compared.Advanced = true
			}
			d.finish(id, success(id, objectFromVisual(compared)))
		}
	}) {
		d.finish(id, failure(id, "VISUAL_BASELINE_QUOTA_EXCEEDED", "Visual processing queue is full."))
	}
}

func objectFromVisual[T interface{}](v T) object {
	result, _ := decodeObject(value(v))
	return result
}

func (d *daemon) invalidateVisualTab(p *peer, tab int64) {
	for id, baseline := range d.baselines.visual {
		if baseline.target == p && baseline.frame.Scope.TabId == float64(tab) {
			delete(d.baselines.visual, id)
		}
	}
	for id, pending := range d.pending {
		if pending.target == p && isVisualBaseline(pending.method) && (pending.requestedTab == 0 || pending.requestedTab == tab) {
			d.cancelBrowserRequest(id, pending)
			d.finish(id, failure(id, "VISUAL_BASELINE_INVALIDATED", "Visual capture tab navigated, closed, or left its access scope."))
		}
	}
}
