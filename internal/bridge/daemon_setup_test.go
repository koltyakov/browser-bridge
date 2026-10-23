package bridge

import (
	"testing"
	"time"
)

func TestSetupWorkDoesNotHoldRoutingLock(t *testing.T) {
	d := serviceTestDaemon(t)
	setup := serviceTestPeer(t, d, "agent")
	health := serviceTestPeer(t, d, "agent")
	started, release := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() { close(release); d.setupWorkers.Wait() })
	d.mu.Lock()
	d.setupRequest(setup, newRequest("setup.get_status", nil, nil, 0), func() (object, error) {
		close(started)
		<-release
		return object{}, nil
	}, "INTERNAL_ERROR")
	d.mu.Unlock()
	<-started
	completed := make(chan struct{})
	go func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		d.route(health, newRequest("health.ping", nil, nil, 0))
		close(completed)
	}()
	select {
	case <-completed:
		if !serviceNextMessage(t, health).object("response").boolean("ok") {
			t.Fatal("health failed")
		}
	case <-time.After(time.Second):
		t.Fatal("setup work blocked unrelated routing")
	}
}

func TestSetupAdmissionAndDisconnectedQueue(t *testing.T) {
	d := serviceTestDaemon(t)
	p := serviceTestPeer(t, d, "agent")
	d.setupMu.Lock()
	d.mu.Lock()
	called := false
	work := func() (object, error) { called = true; return object{}, nil }
	if !d.startSetupTask(p, "one", work, func(object, error) {}) || d.startSetupTask(p, "one", work, func(object, error) {}) || !d.startSetupTask(p, "two", work, func(object, error) {}) || d.startSetupTask(p, "three", work, func(object, error) {}) {
		t.Fatal("setup admission is not bounded or deduplicated")
	}
	delete(d.peers, p)
	d.mu.Unlock()
	d.setupMu.Unlock()
	d.setupWorkers.Wait()
	if called || d.setupJobs != 0 || len(d.setupPending) != 0 {
		t.Fatal("disconnected queued setup ran or retained state")
	}
}
