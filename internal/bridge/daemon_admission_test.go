package bridge

import (
	"bufio"
	"net"
	"testing"
	"time"
)

func TestDaemonHandshakeBudgetEvictsOldestIdleConnection(t *testing.T) {
	d := serviceTestDaemon(t)
	waiting := []*peer{}
	for i := 0; i < maxUnregisteredPeers; i++ {
		p := serviceTestPeer(t, d, "")
		p.accepted = time.Now().Add(time.Duration(i) * time.Millisecond)
		waiting = append(waiting, p)
	}
	if !d.admitConnection() {
		t.Fatal("idle handshakes blocked a new connection")
	}
	if d.peers[waiting[0]] || len(d.peers) != maxUnregisteredPeers-1 {
		t.Fatal("the oldest idle handshake was not evicted")
	}
	if _, err := waiting[0].conn.Write([]byte("x")); err == nil {
		t.Fatal("evicted handshake connection stayed open")
	}
	for i := 0; i < maxRegisteredPeers; i++ {
		serviceTestPeer(t, d, "agent")
	}
	if d.admitConnection() {
		t.Fatal("connection admitted beyond the registered peer limit")
	}
}

func TestDaemonRejectsRegistrationFromEvictedConnection(t *testing.T) {
	d := serviceTestDaemon(t)
	d.agentToken = "token"
	server, client := net.Pipe()
	t.Cleanup(func() { _ = server.Close(); _ = client.Close() })
	p := &peer{conn: server, out: make(chan queuedMessage, 32), done: make(chan struct{}), identity: object{}, owner: uniqueID(), dataTargets: make(map[*peer]bool)}
	done := make(chan struct{})
	go func() {
		defer close(done)
		d.serve(p)
	}()
	writer := wireWriter{out: client}
	if err := writer.send(object{"type": value("register"), "role": value("agent"), "authToken": value("token"), "clientId": value("evicted")}); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	reply, err := readLine(bufio.NewReader(client))
	if err != nil || reply.text("type") != "registration_failed" {
		t.Fatalf("evicted connection registered: %v %v", reply, err)
	}
	<-done
}
