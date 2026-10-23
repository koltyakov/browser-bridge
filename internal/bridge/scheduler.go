package bridge

import "time"

const maxScheduledMutations = 128

// All scheduler state belongs to daemon.mu. Browser completion, not the caller's
// timeout, releases a running slot: canceled native input may still need key-up.
type scheduledMutation struct {
	id       string
	target   *peer
	tab      int64
	ready    time.Time
	granted  time.Time
	canceled bool
}

type mutationScheduler struct {
	entries map[string]*scheduledMutation
	queues  map[*peer][]*scheduledMutation
}

func (d *daemon) scheduleMutation(id string, pending *pendingRequest) bool {
	if !pending.target.identity.boolean("mutationScheduling") || !stringIn(pending.method, catalog.MutationMethods) {
		delete(pending.meta, "mutation_schedule")
		return true
	}
	s := &d.scheduler
	if s.entries == nil {
		s.entries = make(map[string]*scheduledMutation)
		s.queues = make(map[*peer][]*scheduledMutation)
	}
	if len(s.entries) >= maxScheduledMutations || len(s.queues[pending.target]) >= 32 {
		return false
	}
	entry := &scheduledMutation{id: id, target: pending.target}
	s.entries[id] = entry
	s.queues[pending.target] = append(s.queues[pending.target], entry)
	pending.meta["mutation_schedule"] = value(true)
	return true
}

func (d *daemon) mutationReady(p *peer, message object) {
	entry := d.scheduler.entries[message.text("requestId")]
	if entry == nil || entry.target != p || !entry.ready.IsZero() {
		return
	}
	tab, valid := serviceInteger(message, "tabId")
	if !valid || tab <= 0 || tab > 9_007_199_254_740_991 {
		d.finish(entry.id, failure(entry.id, "INVALID_REQUEST", "Invalid mutation scheduling target."))
		return
	}
	entry.tab, entry.ready = tab, time.Now()
	if pending := d.pending[entry.id]; pending != nil {
		pending.prepared = entry.ready
	}
	d.grantMutations(p)
}

func (d *daemon) grantMutations(target *peer) {
	if !d.peers[target] || !target.access {
		return
	}
	busy := map[int64]bool{}
	for _, entry := range d.scheduler.queues[target] {
		if !entry.granted.IsZero() {
			busy[entry.tab] = true
		}
	}
	for _, entry := range d.scheduler.queues[target] {
		if !entry.granted.IsZero() || entry.canceled {
			continue
		}
		// An earlier preparation has not identified its tab yet. Do not reorder
		// later mutations around it until its target is known.
		if entry.ready.IsZero() {
			break
		}
		if busy[entry.tab] {
			continue
		}
		pending := d.pending[entry.id]
		if pending == nil {
			continue
		}
		entry.granted = time.Now()
		pending.dispatched = entry.granted
		busy[entry.tab] = true
		target.send(object{"type": value("extension.mutation_granted"), "requestId": value(entry.id)})
	}
}

func (d *daemon) revokeMutations(target *peer) {
	for id, entry := range d.scheduler.entries {
		if entry.target != target {
			continue
		}
		if pending := d.pending[id]; pending != nil {
			d.cancelBrowserRequest(id, pending)
			d.finish(id, failure(pending.original, "ACCESS_DENIED", "Window access was revoked. Inspect postconditions before another deliberate mutation."))
		}
	}
}

func (d *daemon) removeMutation(id string, target *peer) {
	entry := d.scheduler.entries[id]
	if entry == nil || entry.target != target {
		return
	}
	delete(d.scheduler.entries, id)
	queue := d.scheduler.queues[target]
	for i, candidate := range queue {
		if candidate == entry {
			queue = append(queue[:i], queue[i+1:]...)
			break
		}
	}
	if len(queue) == 0 {
		delete(d.scheduler.queues, target)
	} else {
		d.scheduler.queues[target] = queue
	}
	d.grantMutations(target)
}

func (d *daemon) cancelMutation(id string) {
	entry := d.scheduler.entries[id]
	if entry == nil {
		return
	}
	if entry.granted.IsZero() {
		d.removeMutation(id, entry.target)
	} else {
		entry.canceled = true
	}
}

func (d *daemon) schedulerMetrics() object {
	var preparing, queued, running, canceling int
	for _, entry := range d.scheduler.entries {
		switch {
		case entry.ready.IsZero():
			preparing++
		case entry.granted.IsZero():
			queued++
		default:
			running++
			if entry.canceled {
				canceling++
			}
		}
	}
	return object{"preparing": value(preparing), "queued": value(queued), "running": value(running), "canceling": value(canceling), "capacity": value(maxScheduledMutations)}
}
