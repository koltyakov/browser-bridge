package bridge

import (
	"math"
	"testing"
	"time"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

func TestDaemonPendingTimeoutClampsBeforeAddingMargin(t *testing.T) {
	for _, timeout := range []int64{math.MaxInt64, protocol.MaxDaemonPendingTimeoutMS, protocol.MaxDaemonPendingTimeoutMS - protocol.DaemonPendingTimeoutMarginMS} {
		if got := daemonPendingTimeout(object{"timeoutMs": value(timeout)}); got != protocol.MaxDaemonPendingTimeoutMS*time.Millisecond {
			t.Fatalf("timeout %d overflowed or escaped the upper bound: %s", timeout, got)
		}
	}
	for _, params := range []object{nil, {"timeoutMs": value(0)}, {"timeoutMs": value(math.MinInt64)}} {
		if got := daemonPendingTimeout(params); got != protocol.DefaultDaemonPendingTimeoutMS*time.Millisecond {
			t.Fatalf("invalid or short timeout changed the default: %s", got)
		}
	}
}
