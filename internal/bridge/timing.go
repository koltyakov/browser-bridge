package bridge

import "time"

// Fixed histograms keep telemetry bounded and content-free. Percentiles are
// bucket upper bounds, not exact samples. The final bucket covers the full
// request deadline plus transport/cleanup delay.
var timingBounds = [...]int64{0, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, 120000}

type timingDistribution struct {
	count, total, maximum int64
	buckets               [len(timingBounds) + 1]int64
}

func (t *timingDistribution) add(ms int64) {
	ms = max(0, ms)
	t.count++
	t.total += ms
	t.maximum = max(t.maximum, ms)
	i := 0
	for i < len(timingBounds) && ms > timingBounds[i] {
		i++
	}
	t.buckets[i]++
}

func (t *timingDistribution) snapshot() object {
	percentile := func(percent int64) *int64 {
		if t.count == 0 {
			return nil
		}
		rank, seen := (t.count*percent+99)/100, int64(0)
		for i, count := range t.buckets {
			seen += count
			if seen >= rank {
				if i == len(timingBounds) {
					return &t.maximum
				}
				return &timingBounds[i]
			}
		}
		return nil
	}
	out := object{"count": value(t.count), "totalMs": value(t.total), "maxMs": value(t.maximum)}
	for key, percent := range map[string]int64{"p50UpperBoundMs": 50, "p95UpperBoundMs": 95} {
		out[key] = value(percentile(percent))
	}
	return out
}

type requestTimingMetrics struct {
	total, preparation, queue, execution timingDistribution
}

func (t *requestTimingMetrics) record(pending *pendingRequest) {
	t.total.add(time.Since(pending.started).Milliseconds())
	if !pending.dispatched.IsZero() {
		t.preparation.add(pending.prepared.Sub(pending.started).Milliseconds())
		t.queue.add(pending.dispatched.Sub(pending.prepared).Milliseconds())
		t.execution.add(time.Since(pending.dispatched).Milliseconds())
	}
}

func (t *requestTimingMetrics) snapshot() object {
	return object{"total": value(t.total.snapshot()), "scheduledPreparation": value(t.preparation.snapshot()), "scheduledQueue": value(t.queue.snapshot()), "scheduledExecution": value(t.execution.snapshot())}
}
