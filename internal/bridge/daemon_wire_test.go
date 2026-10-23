package bridge

import (
	"bufio"
	"net"
	"strings"
	"testing"
	"time"
)

func TestDaemonRejectsInvalidWireRegistration(t *testing.T) {
	for _, registration := range []object{
		{"type": value("register"), "role": value("agent"), "authToken": value("incorrect"), "clientId": value("test")},
		{"type": value("register"), "role": value("extension"), "authToken": value(strings.Repeat("a", 43))},
		{"type": value("register"), "role": value("agent"), "authToken": value(strings.Repeat("a", 43)), "clientId": value("bad\nclient")},
	} {
		d := serviceTestDaemon(t)
		d.agentToken, d.extensionToken = strings.Repeat("a", 43), strings.Repeat("e", 43)
		server, connection := net.Pipe()
		p := &peer{conn: server, out: make(chan queuedMessage, 32), done: make(chan struct{}), identity: object{}, dataTargets: make(map[*peer]bool)}
		d.peers[p] = true
		finished := make(chan struct{})
		go func() { defer close(finished); d.serve(p) }()
		t.Cleanup(func() { _ = connection.Close(); _ = server.Close(); <-finished })
		writer := wireWriter{out: connection}
		if err := writer.send(registration); err != nil {
			t.Fatal(err)
		}
		_ = connection.SetReadDeadline(time.Now().Add(time.Second))
		reply, err := readLine(bufio.NewReader(connection))
		if err != nil || reply.text("type") != "registration_failed" || reply.object("error").text("code") != "ACCESS_DENIED" {
			t.Fatalf("registration was not rejected: %s %v", value(reply), err)
		}
	}
}

func TestDaemonWireCorrelatesSameRequestIDAcrossClients(t *testing.T) {
	d := serviceTestDaemon(t)
	d.agentToken, d.extensionToken = strings.Repeat("a", 43), strings.Repeat("e", 43)
	extension, extensionReader := serviceWirePeer(t, d, "extension")
	first, firstReader := serviceWirePeer(t, d, "agent")
	second, secondReader := serviceWirePeer(t, d, "agent")
	requests := []object{}
	for _, writer := range []*wireWriter{first, second} {
		request := newRequest("page.get_state", nil, nil, 1)
		request["id"] = value("shared-id")
		if err := writer.send(object{"type": value("agent.request"), "request": value(request)}); err != nil {
			t.Fatal(err)
		}
		forwarded, err := readLine(extensionReader)
		if err != nil {
			t.Fatal(err)
		}
		requests = append(requests, forwarded.object("request"))
	}
	if requests[0].text("id") == requests[1].text("id") {
		t.Fatal("daemon did not isolate request IDs")
	}
	for i := 1; i >= 0; i-- {
		if err := extension.send(object{"type": value("extension.response"), "response": value(success(requests[i].text("id"), object{"client": value(i)}))}); err != nil {
			t.Fatal(err)
		}
	}
	for i, reader := range []*bufio.Reader{firstReader, secondReader} {
		message, err := readLine(reader)
		response := message.object("response")
		if err != nil || response.text("id") != "shared-id" || response.object("result").number("client") != int64(i) {
			t.Fatalf("response reached wrong client: %s %v", value(message), err)
		}
	}
}
