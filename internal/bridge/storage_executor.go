package bridge

import "sync"

type storageJob struct {
	bytes int
	work  func()
}

// Disk work is ordered independently of daemon routing. Reserve slots for
// cleanup so saturated transfers cannot retain files after their owner leaves.
type storageExecutor struct {
	mu      sync.Mutex
	jobs    []storageJob
	bytes   int
	running bool
	workers sync.WaitGroup
}

func (s *storageExecutor) submit(bytes int, cleanup bool, work func()) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	limit := 256
	if cleanup {
		limit = 512
	}
	if len(s.jobs) >= limit || (!cleanup && s.bytes+bytes > 4*maxMessageBytes) {
		return false
	}
	s.jobs = append(s.jobs, storageJob{bytes, work})
	s.bytes += bytes
	if !s.running {
		s.running = true
		s.workers.Add(1)
		go s.run()
	}
	return true
}

func (s *storageExecutor) run() {
	defer s.workers.Done()
	for {
		s.mu.Lock()
		if len(s.jobs) == 0 {
			s.running = false
			s.jobs = nil
			s.mu.Unlock()
			return
		}
		job := s.jobs[0]
		s.jobs[0] = storageJob{}
		s.jobs = s.jobs[1:]
		s.bytes -= job.bytes
		s.mu.Unlock()
		job.work()
	}
}

// Called under daemon.mu. Results return under that mutex; work never does.
// A nil executor supports direct, synchronous service callers and unit fixtures.
func (d *daemon) store(bytes int, cleanup bool, work func() func()) bool {
	if d.storage == nil {
		if complete := work(); complete != nil {
			complete()
		}
		return true
	}
	return d.storage.submit(bytes, cleanup, func() {
		complete := work()
		if complete != nil {
			d.mu.Lock()
			defer d.mu.Unlock()
			complete()
		}
	})
}

func (d *daemon) cleanupArtifacts(request, owner, extension string, preserve bool) {
	d.store(0, true, func() func() {
		d.artifacts.cleanup(request, owner, extension, preserve)
		return nil
	})
}

func (d *daemon) disconnectRecordings(extension string) {
	d.store(0, true, func() func() { d.recordings.disconnect(extension); return nil })
}

func (d *daemon) storageRequest(p *peer, request object, work func() object) {
	id := request.text("id")
	if p.pending >= 16 {
		d.localResponse(p, request, failure(id, "ARTIFACT_QUOTA_EXCEEDED", "Storage request capacity reached."))
		return
	}
	if d.setupPending == nil {
		d.setupPending = make(map[*peer]map[string]bool)
	}
	if d.setupPending[p] == nil {
		d.setupPending[p] = make(map[string]bool)
	}
	d.setupPending[p][id] = true
	p.pending++
	complete := func(response object) {
		delete(d.setupPending[p], id)
		if len(d.setupPending[p]) == 0 {
			delete(d.setupPending, p)
		}
		p.pending--
		if d.peers[p] {
			d.localResponse(p, request, response)
		}
	}
	if !d.store(len(value(request)), false, func() func() {
		response := work()
		return func() { complete(response) }
	}) {
		complete(failure(id, "ARTIFACT_QUOTA_EXCEEDED", "Storage queue capacity reached."))
	}
}
