package bridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	daemonStartsFile = "daemon-starts.json"
	// Starts are counted in this window to detect a restart loop.
	daemonRestartWindow = time.Minute
	// This many spawns within the window is a loop (doctor reports the same).
	daemonRestartLoopThreshold = 3
	daemonStartHistoryLimit    = 16
	daemonRestartMaxBackoff    = 30 * time.Second
)

// readDaemonStarts returns recorded daemon spawn times in Unix milliseconds.
func readDaemonStarts(home string) []int64 {
	data, err := os.ReadFile(filepath.Join(home, daemonStartsFile))
	if err != nil {
		return nil
	}
	var starts []int64
	if json.Unmarshal(data, &starts) != nil {
		return nil
	}
	return starts
}

// recordDaemonStart appends a spawn time, keeping a short history. Failures
// are ignored: history only shapes back-off and diagnostics.
func recordDaemonStart(home string, now time.Time) {
	starts := append(readDaemonStarts(home), now.UnixMilli())
	cutoff := now.Add(-10 * daemonRestartWindow).UnixMilli()
	kept := starts[:0]
	for _, at := range starts {
		if at >= cutoff {
			kept = append(kept, at)
		}
	}
	if len(kept) > daemonStartHistoryLimit {
		kept = kept[len(kept)-daemonStartHistoryLimit:]
	}
	data, err := json.Marshal(kept)
	if err != nil {
		return
	}
	path := filepath.Join(home, daemonStartsFile)
	temp := path + ".tmp"
	if os.WriteFile(temp, data, 0o600) == nil {
		_ = os.Rename(temp, path)
	}
}

// daemonStartsInWindow counts spawns within the restart window ending now.
func daemonStartsInWindow(starts []int64, now time.Time) (count int, last int64) {
	at := now.UnixMilli()
	for _, start := range starts {
		if start <= at && at-start <= daemonRestartWindow.Milliseconds() {
			count++
			if start > last {
				last = start
			}
		}
	}
	return count, last
}

// daemonRestartBackoff is how long to wait after the last spawn before
// spawning again. It is zero until spawns form a loop, then doubles from
// five seconds up to thirty.
func daemonRestartBackoff(starts []int64, now time.Time) time.Duration {
	count, last := daemonStartsInWindow(starts, now)
	if count < daemonRestartLoopThreshold {
		return 0
	}
	backoff := 5 * time.Second << min(count-daemonRestartLoopThreshold, 3)
	backoff = min(backoff, daemonRestartMaxBackoff)
	remaining := time.UnixMilli(last).Add(backoff).Sub(now)
	return max(remaining, 0)
}

// daemonLogTail returns the last few non-empty lines of daemon.log, which
// usually name why a crash-looping daemon exits (for example a root-owned file).
func daemonLogTail(home string, lines int) string {
	file, err := os.Open(filepath.Join(home, "daemon.log"))
	if err != nil {
		return ""
	}
	defer func() { _ = file.Close() }()
	const window = 8 << 10
	info, err := file.Stat()
	if err != nil {
		return ""
	}
	offset := max(info.Size()-window, 0)
	buffer := make([]byte, info.Size()-offset)
	if _, err := file.ReadAt(buffer, offset); err != nil {
		return ""
	}
	var kept []string
	for line := range bytes.SplitSeq(buffer, []byte("\n")) {
		if text := strings.TrimSpace(string(line)); text != "" {
			kept = append(kept, text)
		}
	}
	if len(kept) > lines {
		kept = kept[len(kept)-lines:]
	}
	return strings.Join(kept, " | ")
}

// daemonRestartLoopError explains why a spawn was skipped and what to check.
func daemonRestartLoopError(home string, count int, wait time.Duration) error {
	cause := daemonLogTail(home, 3)
	if cause != "" {
		cause = "; last daemon.log lines: " + cause
	}
	return fmt.Errorf("the bridge daemon restarted %d times in the last minute, so the next start waits %s%s. Run bbx doctor; files left by a sudo install are a common cause", count, wait.Round(time.Second), cause)
}
