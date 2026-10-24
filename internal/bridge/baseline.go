package bridge

import (
	"encoding/json"
	"regexp"
	"time"
)

var baselineIDPattern = regexp.MustCompile(`^baseline_[A-Za-z0-9_-]{32,64}$`)

type baselineOwner struct {
	target  *peer
	expires time.Time
	order   uint64
}

type baselineRegistry struct {
	visual    map[string]*visualBaseline
	owners    map[string]baselineOwner
	abandoned map[string]baselineOwner
	sequence  uint64
}

func newBaselineRegistry() *baselineRegistry {
	return &baselineRegistry{owners: make(map[string]baselineOwner), abandoned: make(map[string]baselineOwner), visual: make(map[string]*visualBaseline)}
}
func (b *baselineRegistry) prune() {
	now := time.Now()
	for id, baseline := range b.visual {
		if !baseline.expires.After(now) {
			delete(b.visual, id)
		}
	}
	for id, r := range b.owners {
		if !r.expires.After(now) {
			delete(b.owners, id)
		}
	}
	for id, r := range b.abandoned {
		if !r.expires.After(now) {
			delete(b.abandoned, id)
		}
	}
}

func (b *baselineRegistry) register(id string, p *peer, expires string) bool {
	b.prune()
	date, err := time.Parse(time.RFC3339Nano, expires)
	now := time.Now()
	if !baselineIDPattern.MatchString(id) || p.id == "" || err != nil || !date.After(now) || date.After(now.Add(artifactTTL+10*time.Second)) {
		return false
	}
	existing, exists := b.owners[id]
	if exists && existing.target != p {
		return false
	}
	count := 0
	oldestID := ""
	var oldest uint64
	for key, r := range b.owners {
		if r.target == p {
			count++
			if oldestID == "" || r.order < oldest {
				oldestID, oldest = key, r.order
			}
		}
	}
	if !exists && count >= 128 {
		delete(b.owners, oldestID)
	}
	b.sequence++
	if !exists {
		existing.order = b.sequence
	}
	b.owners[id] = baselineOwner{target: p, expires: date, order: existing.order}
	return true
}

func (b *baselineRegistry) abandon(id string, pending *pendingRequest) {
	if pending.method != "dom.baseline.create" {
		return
	}
	b.prune()
	b.sequence++
	b.abandoned[id] = baselineOwner{target: pending.target, expires: time.Now().Add(artifactTTL), order: b.sequence}
	for len(b.abandoned) > 128 {
		oldestID := ""
		var oldest uint64
		for key, r := range b.abandoned {
			if oldestID == "" || r.order < oldest {
				oldestID, oldest = key, r.order
			}
		}
		delete(b.abandoned, oldestID)
	}
}

func (b *baselineRegistry) clear(p *peer) {
	p.accessEpoch++
	for id, baseline := range b.visual {
		if baseline.target == p {
			delete(b.visual, id)
		}
	}
	for id, r := range b.owners {
		if r.target == p {
			delete(b.owners, id)
		}
	}
	for id, r := range b.abandoned {
		if r.target == p {
			delete(b.abandoned, id)
		}
	}
}

func usesBaselineOwner(method string) bool {
	return method == "dom.baseline.compare" || method == "dom.baseline.describe" || method == "dom.baseline.release"
}

func (d *daemon) releaseOrphan(p *peer, result object) {
	id := result.text("baselineId")
	if !baselineIDPattern.MatchString(id) {
		return
	}
	request := newRequest("dom.baseline.release", object{"baselineId": value(id)}, object{"token_budget": value[*int](nil)}, result.object("scope").number("tabId"))
	p.send(object{"type": value("extension.request"), "request": value(request)})
}

func (d *daemon) baselineResponse(p *peer, pending *pendingRequest, response object) object {
	if response.boolean("ok") && pending.method == "dom.baseline.create" {
		result := response.object("result")
		var evicted []object
		_ = json.Unmarshal(result["evicted"], &evicted)
		for _, entry := range evicted {
			id := entry.text("baselineId")
			if d.baselines.owners[id].target == p {
				delete(d.baselines.owners, id)
			}
		}
		if !d.baselines.register(result.text("baselineId"), p, result.text("expiresAt")) {
			d.releaseOrphan(p, result)
			return failure(pending.original, "DOM_BASELINE_INVALIDATED", "DOM baseline owner metadata is invalid.")
		}
	} else if pending.baselineID != "" && ((response.boolean("ok") && pending.method == "dom.baseline.release") || response.object("error").text("code") == "DOM_BASELINE_NOT_FOUND") {
		delete(d.baselines.owners, pending.baselineID)
	}
	return response
}
