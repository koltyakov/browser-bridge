package bridge

import (
	"testing"
	"time"
)

func TestRequestTimingsAreBoundedContentFreeHistograms(t *testing.T) {
	var distribution timingDistribution
	if string(distribution.snapshot()["p50UpperBoundMs"]) != "null" {
		t.Fatal("empty timing distribution claims a percentile")
	}
	for _, ms := range []int64{0, 5, 7, 20, 300000} {
		distribution.add(ms)
	}
	result := distribution.snapshot()
	if result.number("count") != 5 || result.number("p50UpperBoundMs") != 10 || result.number("p95UpperBoundMs") != 300000 {
		t.Fatalf("incorrect timing buckets: %s", value(result))
	}
	start := time.Now().Add(-100 * time.Millisecond)
	pending := &pendingRequest{started: start, prepared: start.Add(10 * time.Millisecond), dispatched: start.Add(60 * time.Millisecond), meta: object{"mutation_schedule": value(true)}}
	timing := requestTiming(pending)
	if timing.number("preparationMs") != 10 || timing.number("queueMs") != 50 || !timing.boolean("scheduled") {
		t.Fatalf("stage timing changed: %s", value(timing))
	}
	var metrics requestTimingMetrics
	metrics.record(pending)
	if metrics.snapshot().object("scheduledQueue").number("count") != 1 {
		t.Fatal("scheduled stage sample was not recorded")
	}
	annotated := cliAnnotate(object{"ok": value(true)}, object{"ok": value(true), "result": value(object{}), "meta": value(object{"timing": value(timing)})})
	if !jsonEqual(annotated["timing"], value(timing)) {
		t.Fatal("MCP/CLI evidence omitted stage timing")
	}
}
