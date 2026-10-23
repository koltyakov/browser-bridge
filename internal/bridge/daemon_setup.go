package bridge

import "errors"

// Setup touches user files, waits for locks and scans installation trees. It
// must never hold daemon.mu. Serialize setup separately, with bounded admission
// and connection-scoped request IDs just like routed browser work.
// The caller must hold daemon.mu while admitting a task.
func (d *daemon) startSetupTask(p *peer, id string, work func() (object, error), reply func(object, error)) bool {
	if d.setupJobs >= 8 || len(d.setupPending[p]) >= 2 || d.setupPending[p][id] {
		return false
	}
	if d.setupPending == nil {
		d.setupPending = make(map[*peer]map[string]bool)
	}
	if d.setupPending[p] == nil {
		d.setupPending[p] = make(map[string]bool)
	}
	d.setupPending[p][id] = true
	d.setupJobs++
	d.setupWorkers.Add(1)
	go func() {
		defer d.setupWorkers.Done()
		d.setupMu.Lock()
		defer d.setupMu.Unlock()
		d.mu.Lock()
		connected := d.peers[p]
		d.mu.Unlock()
		var result object
		var err error
		if connected {
			result, err = work()
		}
		d.mu.Lock()
		defer d.mu.Unlock()
		delete(d.setupPending[p], id)
		if len(d.setupPending[p]) == 0 {
			delete(d.setupPending, p)
		}
		d.setupJobs--
		if d.peers[p] {
			reply(result, err)
		}
	}()
	return true
}

func (d *daemon) setupRequest(p *peer, request object, work func() (object, error), fallback string) {
	if !d.startSetupTask(p, request.text("id"), work, func(result object, err error) {
		d.localResponse(p, request, serviceResponse(request.text("id"), result, err, fallback))
	}) {
		d.localResponse(p, request, failure(request.text("id"), "INVALID_REQUEST", "Setup request limit reached or request id is already pending."))
	}
}

func (d *daemon) setupStatusMessage(p *peer, message object) {
	reply := func(status object, err error) {
		if err != nil {
			p.send(object{"type": value("extension.setup_status.error"), "requestId": message["requestId"], "error": value(object{"message": value(err.Error())})})
		} else {
			p.send(object{"type": value("extension.setup_status.response"), "requestId": message["requestId"], "status": value(status)})
		}
	}
	if !validID(message.text("requestId")) || !d.startSetupTask(p, "status:"+message.text("requestId"), func() (object, error) {
		return setupStatus(d.config)
	}, reply) {
		reply(nil, errors.New("Setup request limit reached or invalid request id."))
	}
}
