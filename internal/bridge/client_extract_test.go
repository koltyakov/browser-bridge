package bridge

import (
	"bufio"
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

func TestCLIExtractionKeepsRoutingAndClearsSnapshotBudget(t *testing.T) {
	agent, daemon := net.Pipe()
	defer daemon.Close()
	cl := &client{conn: agent, writer: wireWriter{out: agent}, pending: make(map[string]chan callResult)}
	defer cl.close()
	go cl.read(bufio.NewReader(agent))
	received := make(chan object, 2)
	errors := make(chan error, 1)
	go func() {
		reader := bufio.NewReader(daemon)
		writer := wireWriter{out: daemon}
		for _, result := range []object{
			{"title": value("Article"), "url": value("https://example.test/article")},
			{"html": value("<main><p>Extracted text survives the caller budget.</p></main>"), "truncated": value(false)},
		} {
			message, err := readLine(reader)
			if err != nil {
				errors <- err
				return
			}
			request := message.object("request")
			received <- request
			if err := writer.send(object{"type": value("agent.response"), "response": value(success(request.text("id"), result))}); err != nil {
				errors <- err
				return
			}
		}
		errors <- nil
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	request := newRequest("page.extract_content", object{"includeMetadata": value(true), "format": value("text"), "textBudget": value(1000)}, object{"source": value("cli"), "target_extension": value("profile-1"), "token_budget": value(1)}, 42)
	response, err := cl.request(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
	metadata := <-received
	if metadata.text("method") != "page.get_state" || metadata.object("meta").number("token_budget") != 1 {
		t.Fatalf("metadata budget changed: %s", value(metadata))
	}
	snapshot := <-received
	if snapshot.text("method") != "dom.get_html" || snapshot.number("tab_id") != 42 || snapshot.object("meta").text("target_extension") != "profile-1" {
		t.Fatalf("lost routing: %s", value(snapshot))
	}
	if string(snapshot.object("meta")["token_budget"]) != "null" {
		t.Fatalf("snapshot was budget-clipped: %s", value(snapshot))
	}
	if response.text("id") != request.text("id") || !response.boolean("ok") || !strings.Contains(string(value(response.object("result"))), "Extracted text survives") {
		t.Fatalf("invalid extracted response: %s", value(response))
	}
}
