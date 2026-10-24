package bridge

import (
	"bytes"
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

var recoveryKinds = []string{"automatic_mcp_retry", "stale_ref_recovery", "debugger_reattach", "content_script_reinjection", "native_host_reconnect", "request_outcome"}
var requestVersionPattern = regexp.MustCompile(`^\d+\.\d+$`)
var browserExtensionIDPattern = regexp.MustCompile(`^[a-p]{32}$`)
var agentSessionPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

func normalizeDaemonRequestMeta(meta object) {
	if raw := meta["protocol_version"]; len(raw) == 0 || raw[0] != '"' {
		meta["protocol_version"] = value(protocolVersion())
	}
	if _, numeric := serviceNumber(meta, "token_budget"); !numeric {
		meta["token_budget"] = value[*int](nil)
	}
	source := meta.text("source")
	if source != "cli" && source != "mcp" {
		delete(meta, "source")
	}
	if source != "mcp" || !stringIn(meta.text("mcp_era"), []string{"legacy", "modern"}) {
		delete(meta, "mcp_era")
	}
	retry := meta.object("automatic_retry")
	attempt, numeric := serviceInteger(retry, "attempt")
	if source != "mcp" || len(retry) != 2 || !numeric || attempt != 2 || retry.text("reason") != "retryable_error" {
		delete(meta, "automatic_retry")
	}
	session := strings.TrimSpace(meta.text("agent_session"))
	if agentSessionPattern.MatchString(session) {
		meta["agent_session"] = value(session)
	} else {
		delete(meta, "agent_session")
	}
}

func daemonErrorRecovery(code string) object {
	return catalog.ErrorRecovery[code]
}

func protectResponseRecovery(response object, method string) {
	if response.boolean("ok") {
		return
	}
	err := response.object("error")
	if err == nil {
		return
	}
	recovery := err.object("recovery")
	if method == "webmcp.execute_tool" {
		recovery = object{"retry": value(false), "hint": value("WebMCP executions are never retried automatically. Inspect postconditions if dispatch may have started; never replay through DOM fallback.")}
	} else if method == "sensitive.read" && recovery != nil {
		result := object{"retry": value(false), "hint": value("Sensitive reads are never retried automatically. " + recovery.text("hint"))}
		if v := recovery["alternativeMethod"]; v != nil {
			result["alternativeMethod"] = v
		}
		recovery = result
	} else {
		return
	}
	err["recovery"] = value(recovery)
	response["error"] = value(err)
}

type recoveryCounts struct{ attempts, successes, failures, last int64 }
type recoveryBucket struct {
	start  int64
	events map[string]recoveryCounts
}
type recoveryGroup struct {
	kind        string
	times       [3]int64
	count, next int
	touched     int64
}
type recoveryTelemetry struct {
	buckets [61]recoveryBucket
	groups  map[string]*recoveryGroup
	now     func() time.Time
}

func (t *recoveryTelemetry) timestamp() int64 {
	if t.now != nil {
		return t.now().UnixMilli()
	}
	return time.Now().UnixMilli()
}
func (t *recoveryTelemetry) pruneGroups(now int64) {
	for key, g := range t.groups {
		recent := false
		for i := 0; i < g.count; i++ {
			if g.times[i] >= now-60000 && g.times[i] <= now {
				recent = true
			}
		}
		if !recent {
			delete(t.groups, key)
		}
	}
}
func (t *recoveryTelemetry) record(kind, method string, ok bool) {
	if !protocol.RecoveryEventKind(kind).Valid() {
		return
	}
	now := t.timestamp()
	if now < 0 {
		now = 0
	}
	start := now / 5000 * 5000
	b := &t.buckets[(start/5000)%61]
	if b.events == nil || b.start != start {
		*b = recoveryBucket{start: start, events: make(map[string]recoveryCounts)}
	}
	e := b.events[kind]
	e.attempts++
	e.last = now
	if ok {
		e.successes++
	} else {
		e.failures++
	}
	b.events[kind] = e
	t.pruneGroups(now)
	if ok {
		return
	}
	if t.groups == nil {
		t.groups = make(map[string]*recoveryGroup)
	}
	key := kind + "\x00" + method
	g := t.groups[key]
	if g == nil {
		for len(t.groups) >= 64 {
			oldest := ""
			var at int64
			for name, group := range t.groups {
				if oldest == "" || group.touched < at {
					oldest, at = name, group.touched
				}
			}
			delete(t.groups, oldest)
		}
		g = &recoveryGroup{kind: kind}
		t.groups[key] = g
	}
	g.times[g.next] = now
	g.next = (g.next + 1) % 3
	g.count = min(3, g.count+1)
	g.touched = now
}

func recoveryEvent(attempts, successes, failures int64, loop bool, last int64) object {
	saturated := attempts > 10000
	if saturated {
		failures = int64(math.Floor(float64(failures) / float64(attempts) * 10000))
		if loop && failures < 3 {
			failures = 3
		}
		attempts, successes = 10000, 10000-failures
	}
	e := object{"attempts": value(attempts), "successes": value(successes), "failures": value(failures), "pending": value(0), "saturated": value(saturated), "successRate": value[*float64](nil), "failureRate": value[*float64](nil), "activeLoop": value(loop), "lastEventAt": value[*int64](nil)}
	if attempts > 0 {
		e["lastEventAt"] = value(last)
		if !saturated {
			e["successRate"] = value(math.Round(float64(successes)/float64(attempts)*10000) / 10000)
			e["failureRate"] = value(math.Round(float64(failures)/float64(attempts)*10000) / 10000)
		}
	}
	return e
}

func recoverySummary(scope string, now int64, events object) object {
	loop := false
	for _, kind := range recoveryKinds {
		if events.object(kind).boolean("activeLoop") {
			loop = true
		}
	}
	return object{"scope": value(scope), "windowMs": value(300000), "bucketMs": value(5000), "loopWindowMs": value(60000), "loopThreshold": value(3), "asOf": value(now), "activeLoop": value(loop), "events": value(events)}
}

func (t *recoveryTelemetry) snapshot(scope string) object {
	now := t.timestamp()
	if now < 0 {
		now = 0
	}
	t.pruneGroups(now)
	events := object{}
	for _, kind := range recoveryKinds {
		var sum recoveryCounts
		for _, b := range t.buckets {
			if b.start+5000 <= now-300000 || b.start > now {
				continue
			}
			e := b.events[kind]
			sum.attempts += e.attempts
			sum.successes += e.successes
			sum.failures += e.failures
			sum.last = max(sum.last, e.last)
		}
		loop := false
		for _, g := range t.groups {
			if g.kind != kind || g.count < 3 {
				continue
			}
			recent := true
			for _, at := range g.times {
				if at < now-60000 || at > now {
					recent = false
				}
			}
			loop = loop || recent
		}
		events[kind] = value(recoveryEvent(sum.attempts, sum.successes, sum.failures, loop, sum.last))
	}
	return recoverySummary(scope, now, events)
}

func normalizeRecovery(source object, scope string) object {
	if source.text("scope") != scope {
		return nil
	}
	asOf, valid := serviceInteger(source, "asOf")
	if !valid || asOf < 0 {
		return nil
	}
	events := object{}
	for _, kind := range recoveryKinds {
		e := source.object("events").object(kind)
		attempts, aOK := serviceInteger(e, "attempts")
		successes, sOK := serviceInteger(e, "successes")
		failures, fOK := serviceInteger(e, "failures")
		pending, pOK := serviceInteger(e, "pending")
		saturated := e.boolean("saturated")
		if !aOK || !sOK || !fOK || !pOK || attempts < 0 || successes < 0 || failures < 0 || pending < 0 || successes+failures+pending != attempts || attempts > 10000 || (saturated && attempts != 10000) || !jsonBoolean(e["saturated"]) {
			return nil
		}
		last, lastOK := serviceInteger(e, "lastEventAt")
		if (attempts == 0 && !bytes.Equal(e["lastEventAt"], []byte("null"))) || (attempts > 0 && (!lastOK || last < 0 || last > asOf || last < asOf-305000)) {
			return nil
		}
		normal := recoveryEvent(attempts, successes, failures, e.boolean("activeLoop") && failures >= 3, last)
		normal["pending"], normal["saturated"] = value(pending), value(saturated)
		if saturated {
			normal["successRate"], normal["failureRate"] = value[*float64](nil), value[*float64](nil)
		}
		events[kind] = value(normal)
	}
	return recoverySummary(scope, asOf, events)
}

func stringIn(s string, values []string) bool {
	for _, v := range values {
		if s == v {
			return true
		}
	}
	return false
}
func jsonBoolean(v json.RawMessage) bool {
	return bytes.Equal(v, []byte("true")) || bytes.Equal(v, []byte("false"))
}

func (d *daemon) recordOutcome(method string, meta object, ok bool) {
	if stringIn(method, []string{"health.ping", "daemon.metrics", "log.tail", "setup.get_status", "setup.install"}) {
		return
	}
	d.telemetry.record("request_outcome", method, ok)
	retry := meta.object("automatic_retry")
	if meta.text("source") == "mcp" && len(retry) == 2 && retry.number("attempt") == 2 && retry.text("reason") == "retryable_error" {
		d.telemetry.record("automatic_mcp_retry", method, ok)
	}
}

func (d *daemon) recordCompletion(pending *pendingRequest, ok bool) {
	d.processed++
	if !ok {
		d.failed++
	}
	if !pending.started.IsZero() {
		d.responseMillis += time.Since(pending.started).Milliseconds()
		d.timings.record(pending)
	}
	d.recordOutcome(pending.method, pending.meta, ok)
}

// Execution includes bridge transport and browser work, not just DOM CPU time.
// These timings contain no browser content or target identifiers.
func requestTiming(pending *pendingRequest) object {
	now := time.Now()
	prepared, dispatched := pending.prepared, pending.dispatched
	if prepared.IsZero() {
		prepared = pending.started
		if pending.meta.boolean("mutation_schedule") {
			prepared = now
		}
	}
	if dispatched.IsZero() {
		dispatched = now
		if !pending.meta.boolean("mutation_schedule") {
			dispatched = pending.started
		}
	}
	return object{
		"preparationMs": value(max(0, prepared.Sub(pending.started).Milliseconds())),
		"queueMs":       value(max(0, dispatched.Sub(prepared).Milliseconds())),
		"executionMs":   value(max(0, now.Sub(dispatched).Milliseconds())),
		"totalMs":       value(max(0, now.Sub(pending.started).Milliseconds())),
		"scheduled":     value(pending.meta.boolean("mutation_schedule")),
	}
}

var extensionVersionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
var workerIDPattern = regexp.MustCompile(`^[a-f0-9-]{36}$`)
var supportedVersionPattern = regexp.MustCompile(`^\d+\.\d+(\.\d+)?([-+][A-Za-z0-9.-]+)?$`)

func healthCounts(source object, keys []string) object {
	result := object{}
	for _, key := range keys {
		n, ok := serviceNumber(source, key)
		if ok && n >= 0 {
			result[key] = value(int64(math.Min(10000, math.Trunc(n))))
		}
	}
	return result
}

func normalizeExtensionHealth(source object, diagnostics bool) object {
	result := object{}
	if source == nil {
		return result
	}
	if source.text("extension") == "ok" {
		result["extension"] = value("ok")
	}
	if extensionVersionPattern.MatchString(source.text("extensionVersion")) {
		result["extensionVersion"] = source["extensionVersion"]
	}
	if access := source.object("access"); access != nil {
		a := object{}
		for _, key := range []string{"enabled", "routeReady"} {
			if jsonBoolean(access[key]) {
				a[key] = access[key]
			}
		}
		for _, key := range []string{"windowId", "routeTabId"} {
			n, ok := serviceInteger(access, key)
			if (ok && n > 0) || bytes.Equal(access[key], []byte("null")) {
				a[key] = access[key]
			}
		}
		if stringIn(access.text("reason"), []string{"enabled", "access_disabled", "enabled_window_missing", "no_routable_active_tab", "restricted_page"}) {
			a["reason"] = access["reason"]
		}
		result["access"] = value(a)
	}
	var versions []json.RawMessage
	_ = json.Unmarshal(source["supported_versions"], &versions)
	cleanVersions := []string{}
	for _, raw := range versions {
		var text string
		if json.Unmarshal(raw, &text) == nil && len(text) <= 32 && supportedVersionPattern.MatchString(text) {
			cleanVersions = append(cleanVersions, text)
			if len(cleanVersions) == 10 {
				break
			}
		}
	}
	result["extension_supported_versions"] = value(cleanVersions)
	if !diagnostics {
		return result
	}
	build := source.object("loadedBuild")
	_, dateErr := time.Parse(time.RFC3339Nano, build.text("startedAt"))
	if workerIDPattern.MatchString(build.text("workerId")) && len(build.text("startedAt")) <= 32 && dateErr == nil && (bytes.Equal(build["sourceDigest"], []byte("null")) || digestPattern.MatchString(build.text("sourceDigest"))) {
		result["loadedBuild"] = value(object{"workerId": build["workerId"], "startedAt": build["startedAt"], "sourceDigest": build["sourceDigest"]})
	}
	if debugger := source.object("debugger"); debugger != nil {
		a := healthCounts(debugger, []string{"attachedTabCount", "heldTabCount", "pendingTabCount"})
		if stringIn(debugger.text("status"), []string{"idle", "active"}) {
			a["status"] = debugger["status"]
		}
		if bytes.Equal(debugger["recentReason"], []byte("null")) || stringIn(debugger.text("recentReason"), []string{"debugger_conflict", "debugger_detached", "debugger_replaced", "debugger_canceled", "target_closed"}) {
			a["recentReason"] = debugger["recentReason"]
		}
		result["debugger"] = value(a)
	}
	if capture := source.object("capture"); capture != nil {
		a := healthCounts(capture, []string{"activeTabCount", "ownershipCount", "inflightCount", "interceptionActiveTabCount", "interceptionRuleCount"})
		if stringIn(capture.text("state"), []string{"stopped", "armed", "active", "stop_failed"}) {
			a["state"] = capture["state"]
		}
		result["capture"] = value(a)
	}
	if baselines := source.object("domBaselines"); baselines != nil {
		a := healthCounts(baselines, []string{"baselineCount", "bytes", "tabCount"})
		if operations := baselines.object("operations"); operations != nil {
			ops := object{}
			for _, name := range []string{"create", "get", "compare", "release", "invalidate", "clearTab", "clearWindow", "clearAll", "invalidateNavigation", "pruneExpired"} {
				if source := operations.object(name); source != nil {
					ops[name] = value(healthCounts(source, []string{"calls", "totalLatencyMs", "maxLatencyMs"}))
				}
			}
			a["operations"] = value(ops)
		}
		result["domBaselines"] = value(a)
	}
	return result
}

var incidentalHeaderPattern = regexp.MustCompile(`(?i)\b(authorization|proxy-authorization)\s*:\s*[^\r\n,;]+`)
var incidentalCookiePattern = regexp.MustCompile(`(?i)\b(set-cookie|cookie)\s*:\s*[^\r\n]+`)
var incidentalURLPattern = regexp.MustCompile(`(?i)\b(?:https?|file|blob|chrome|chrome-extension|edge|devtools|data):[^\s"'<>]+`)
var incidentalPathPattern = regexp.MustCompile(`(?:^|[\s"'(])(?:[a-zA-Z]:\\[^\s"')]+|\\\\[^\s"')]+|/(?:Users|home|private|var|tmp|opt|etc|root|usr|srv|mnt|Volumes|Library|Applications)/[^\s"')]+)`)
var incidentalKeyPattern = regexp.MustCompile(`[^a-z0-9]`)
var incidentalCredentialsPattern = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]*://)[^/@\s]*@`)
var incidentalMIMEPattern = regexp.MustCompile(`[^a-zA-Z0-9./+-]`)

func servicePathSummary(s string) string {
	parts := strings.FieldsFunc(s, func(r rune) bool { return r == '/' || r == '\\' })
	if len(parts) == 0 {
		return "[redacted-path]"
	}
	name := parts[len(parts)-1]
	if len(name) > 160 {
		name = name[:160]
	}
	return "[redacted-path]/" + name
}

func serviceURLSummary(s string) string {
	if len(s) > 4096 {
		s = s[:4096]
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "data:") {
		mime := strings.SplitN(strings.SplitN(s[5:], ";", 2)[0], ",", 2)[0]
		mime = incidentalMIMEPattern.ReplaceAllString(mime, "")
		if len(mime) > 100 {
			mime = mime[:100]
		}
		if mime == "" {
			return "data:[redacted]"
		}
		return "data:" + mime + ";[redacted]"
	}
	if strings.HasPrefix(lower, "blob:") {
		u, err := url.Parse(s[5:])
		if err != nil || u.Host == "" {
			return "blob:[redacted]"
		}
		return "blob:" + u.Scheme + "://" + u.Host + "/[redacted]"
	}
	u, err := url.Parse(s)
	if err != nil {
		// Malformed escapes/hosts must not bypass credential redaction. Match
		// the browser sanitizer's conservative fallback before dropping suffixes.
		clean := incidentalCredentialsPattern.ReplaceAllString(s, "$1")
		return strings.SplitN(strings.SplitN(clean, "?", 2)[0], "#", 2)[0]
	}
	if strings.HasPrefix(lower, "file:") {
		return "file:" + servicePathSummary(u.Path)
	}
	u.User, u.Fragment, u.RawFragment = nil, "", ""
	query := u.Query()
	for key := range query {
		query.Set(key, "[redacted]")
	}
	u.RawQuery = query.Encode()
	return u.String()
}

func sanitizeIncidentalServiceText(s string) string {
	s = incidentalHeaderPattern.ReplaceAllString(s, "$1: [redacted]")
	s = incidentalCookiePattern.ReplaceAllString(s, "$1: [redacted]")
	s = incidentalURLPattern.ReplaceAllStringFunc(s, serviceURLSummary)
	s = incidentalPathPattern.ReplaceAllStringFunc(s, func(match string) string {
		prefix := ""
		if len(match) > 0 && strings.ContainsRune(" \t\r\n\"'(\f", rune(match[0])) {
			prefix, match = match[:1], match[1:]
		}
		return prefix + servicePathSummary(match)
	})
	if len(s) > 4096 {
		s = s[:4096]
	}
	return s
}

func sanitizeLogValue(raw json.RawMessage, key string, depth int, nodes *int) json.RawMessage {
	*nodes++
	if *nodes > 1000 || depth >= 8 {
		return value("[truncated]")
	}
	canonical := incidentalKeyPattern.ReplaceAllString(strings.ToLower(key), "")
	if stringIn(canonical, []string{"authorization", "proxyauthorization", "cookie", "setcookie", "password", "passphrase", "secret", "clientsecret", "token", "accesstoken", "refreshtoken", "idtoken", "authtoken", "apikey", "credential", "credentials"}) {
		return value("[redacted]")
	}
	var text string
	if json.Unmarshal(raw, &text) == nil && !bytes.Equal(raw, []byte("null")) {
		lower := strings.ToLower(key)
		if strings.Contains(lower, "url") || strings.Contains(lower, "uri") || strings.Contains(lower, "href") || strings.Contains(lower, "endpoint") {
			return value(serviceURLSummary(text))
		}
		if (strings.Contains(lower, "path") || strings.Contains(lower, "directory") || strings.Contains(lower, "filename")) && incidentalPathPattern.MatchString(text) {
			return value(servicePathSummary(text))
		}
		return value(sanitizeIncidentalServiceText(text))
	}
	if o, err := decodeObject(raw); err == nil {
		out := object{}
		for k, v := range o {
			safe := sanitizeIncidentalServiceText(k)
			if len(safe) > 160 {
				safe = safe[:160]
			}
			out[safe] = sanitizeLogValue(v, k, depth+1, nodes)
		}
		return value(out)
	}
	var array []json.RawMessage
	if json.Unmarshal(raw, &array) == nil && array != nil {
		for i, v := range array {
			array[i] = sanitizeLogValue(v, "", depth+1, nodes)
		}
		return value(array)
	}
	return raw
}

func (d *daemon) pushServiceLog(entry object) {
	if entry == nil {
		entry = object{}
	}
	nodes := 0
	clean, _ := decodeObject(sanitizeLogValue(value(entry), "", 0, &nodes))
	d.logs = append(d.logs, clean)
	if len(d.logs) > protocol.DaemonRecentLogLimit {
		d.logs = d.logs[len(d.logs)-protocol.DaemonRecentLogLimit:]
	}
}
