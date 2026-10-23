package bridge

import (
	"testing"
	"time"
)

func TestMutationSchedulerSerializesTabsAndHoldsCanceledInput(t *testing.T) {
	d := serviceTestDaemon(t)
	extension := serviceTestPeer(t, d, "extension")
	extension.identity["mutationScheduling"] = value(true)
	first, second := serviceTestPeer(t, d, "agent"), serviceTestPeer(t, d, "agent")
	route := func(owner *peer, tab int64) object {
		t.Helper()
		request := newRequest("input.click", object{"target": value(object{"selector": value("button")})}, nil, tab)
		d.route(owner, request)
		message := <-extension.out
		forwarded := message.message.object("request")
		if !forwarded.object("meta").boolean("mutation_schedule") {
			t.Fatal("mutation was not scheduled")
		}
		return forwarded
	}
	a, b, c := route(first, 12), route(second, 12), route(second, 34)
	ready := func(request object, tab int) {
		d.handle(extension, object{"type": value("extension.mutation_ready"), "requestId": request["id"], "tabId": value(tab)})
	}
	ready(b, 12)
	if len(extension.out) != 0 {
		t.Fatal("later preparation passed the earlier unknown target")
	}
	ready(a, 12)
	if grant := (<-extension.out).message; grant.text("requestId") != a.text("id") {
		t.Fatalf("wrong first grant: %s", value(grant))
	}
	ready(c, 34)
	if grant := (<-extension.out).message; grant.text("requestId") != c.text("id") {
		t.Fatalf("independent tab was blocked: %s", value(grant))
	}
	d.handle(first, object{"type": value("agent.cancel"), "requestId": value(d.pending[a.text("id")].original)})
	if cancel := (<-extension.out).message; cancel.text("type") != "extension.request_cancelled" {
		t.Fatalf("cancel was not delivered: %s", value(cancel))
	}
	<-first.out
	if len(extension.out) != 0 || d.schedulerMetrics().number("canceling") != 1 {
		t.Fatal("caller cancellation released an input that has not settled")
	}
	d.response(extension, success(a.text("id"), object{}))
	if grant := (<-extension.out).message; grant.text("requestId") != b.text("id") {
		t.Fatalf("settled input did not release its slot: %s", value(grant))
	}
	d.response(extension, success(b.text("id"), object{}))
	d.response(extension, success(c.text("id"), object{}))
	if len(d.scheduler.entries) != 0 {
		t.Fatal("completed mutations retained scheduler entries")
	}
}

func TestMutationSchedulerDoesNotScheduleReadsOrTrustAgentMetadata(t *testing.T) {
	d := serviceTestDaemon(t)
	extension := serviceTestPeer(t, d, "extension")
	extension.identity["mutationScheduling"] = value(true)
	agent := serviceTestPeer(t, d, "agent")
	request := newRequest("page.get_state", nil, object{"mutation_schedule": value(true)}, 12)
	d.route(agent, request)
	forwarded := (<-extension.out).message.object("request")
	if forwarded.object("meta")["mutation_schedule"] != nil || len(d.scheduler.entries) != 0 {
		t.Fatal("agent metadata enabled scheduling for a read")
	}
	d.response(extension, success(forwarded.text("id"), object{}))
	response := (<-agent.out).message.object("response")
	if response.object("meta").object("timing").boolean("scheduled") {
		t.Fatal("read timing claimed scheduling")
	}
}

func TestMutationSchedulerRevokesQueuedWorkButRetainsRunningSlots(t *testing.T) {
	d := serviceTestDaemon(t)
	extension := serviceTestPeer(t, d, "extension")
	extension.identity["mutationScheduling"] = value(true)
	agent := serviceTestPeer(t, d, "agent")
	ids := []string{}
	for i := 0; i < 2; i++ {
		d.route(agent, newRequest("input.perform", object{"steps": value([]object{})}, nil, 12))
		id := serviceNextMessage(t, extension).object("request").text("id")
		ids = append(ids, id)
		d.mutationReady(extension, object{"requestId": value(id), "tabId": value(12)})
		if i == 0 {
			serviceNextMessage(t, extension)
		}
	}
	d.handle(extension, object{"type": value("extension.access_update"), "accessEnabled": value(false)})
	for i := 0; i < 2; i++ {
		if serviceNextMessage(t, agent).object("response").object("error").text("code") != "ACCESS_DENIED" {
			t.Fatal("revoked mutation did not fail")
		}
		if serviceNextMessage(t, extension).text("type") != "extension.request_cancelled" {
			t.Fatal("revoked work did not receive cancellation")
		}
	}
	if d.schedulerMetrics().number("canceling") != 1 || len(d.scheduler.entries) != 1 {
		t.Fatal("revocation released running input or retained unstarted input")
	}
	d.response(extension, failure(ids[0], "ACCESS_DENIED", "settled"))
	if len(d.scheduler.entries) != 0 {
		t.Fatal("settled revoked input retained its slot")
	}
}

func TestMutationSchedulerCapacityOwnershipAndQueuedCancellation(t *testing.T) {
	d := serviceTestDaemon(t)
	extension := serviceTestPeer(t, d, "extension")
	extension.identity["mutationScheduling"] = value(true)
	other := serviceTestPeer(t, d, "extension")
	agent := serviceTestPeer(t, d, "agent")
	for i := 0; i < 32; i++ {
		id := uniqueID()
		pending := &pendingRequest{target: extension, method: "input.perform", meta: object{}}
		if !d.scheduleMutation(id, pending) {
			t.Fatal("queue filled early")
		}
		d.removeMutation(id, other)
		if d.scheduler.entries[id] == nil {
			t.Fatal("another profile released the scheduling slot")
		}
	}
	if d.scheduleMutation(uniqueID(), &pendingRequest{target: extension, method: "input.click", meta: object{}}) {
		t.Fatal("unbounded per-profile queue")
	}
	for id := range d.scheduler.entries {
		d.cancelMutation(id)
	}
	if len(d.scheduler.entries) != 0 {
		t.Fatal("unstarted canceled work retained capacity")
	}
	delete(d.peers, other)
	id := uniqueID()
	pending := &pendingRequest{target: extension, owner: agent, method: "input.click", original: id, meta: object{}, started: time.Now()}
	if !d.scheduleMutation(id, pending) {
		t.Fatal("capacity did not recover")
	}
	d.pending[id] = pending
	agent.pending++
	pending.timer = time.AfterFunc(time.Hour, func() {})
	d.mutationReady(extension, object{"requestId": value(id), "tabId": value("wrong")})
	if (<-agent.out).message.object("response").object("error").text("code") != "INVALID_REQUEST" {
		t.Fatal("invalid scheduling target was not rejected")
	}
}
