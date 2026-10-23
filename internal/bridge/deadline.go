package bridge

import (
	"math"
	"strings"
	"time"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

type operationTimeoutField struct {
	Field    string `json:"field"`
	Fallback int64  `json:"fallback"`
	Min      int64  `json:"min"`
	Max      int64  `json:"max"`
}

type operationTimeoutPolicy struct {
	Base   int64                   `json:"base"`
	Fields []operationTimeoutField `json:"fields"`
}

func daemonOperationTimeout(method string, params object) time.Duration {
	timeout := daemonPendingTimeout(params)
	if strings.HasPrefix(method, "input.") && method != "input.perform" {
		hold := serviceClampInt(params, "holdMs", 0, protocol.MaxInputHoldMS, 0)
		if method == "input.click" && serviceClampInt(params, "clickCount", 1, 2, 1) == 2 {
			hold *= 2
		}
		wait := serviceClampInt(params, "timeoutMs", 0, protocol.MaxInputWaitMS, protocol.DefaultInputWaitMS)
		settle := serviceClampInt(params.object("observe"), "settleMs", 0, protocol.MaxObserveSettleMS, protocol.DefaultObserveSettleMS)
		if string(params["observe"]) == "false" || string(params["observe"]) == "null" {
			settle = 0
		}
		duration := serviceClampInt(params, "duration", 0, protocol.MaxObserveSettleMS, 0)
		milliseconds := hold + wait + settle + duration + protocol.InputHoldTimeoutMarginMS + protocol.DaemonPendingTimeoutMarginMS
		timeout = max(timeout, time.Duration(milliseconds)*time.Millisecond)
	}
	if policy, ok := catalog.OperationTimeouts[method]; ok {
		milliseconds := policy.Base
		for _, field := range policy.Fields {
			number, valid := serviceNumber(params, field.Field)
			bounded := field.Fallback
			if valid && !math.IsNaN(number) && !math.IsInf(number, 0) {
				bounded = int64(math.Max(float64(field.Min), math.Min(float64(field.Max), math.Trunc(number))))
			}
			milliseconds += bounded
		}
		timeout = max(timeout, time.Duration(milliseconds+protocol.DaemonPendingTimeoutMarginMS)*time.Millisecond)
	}
	return min(timeout, protocol.MaxDaemonPendingTimeoutMS*time.Millisecond)
}
