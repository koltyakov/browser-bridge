package main

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

func stageList(stages verificationStages) []stageResult {
	return []stageResult{stages.EndpointDiscovery, stages.ProfileIsolation, stages.EndpointConnection, stages.ManifestCreation, stages.NativeHostLookup, stages.BridgeConnection}
}

func fakePlan(operations []stageOperation) verificationPlan {
	return verificationPlan{operations[0], operations[1], operations[2], operations[3], operations[4], operations[5]}
}

func TestArcReportsEachFailureAtItsOwnStage(t *testing.T) {
	for failure := -1; failure < 6; failure++ {
		t.Run([]string{"success", "discovery", "isolation", "connection", "manifest", "lookup", "bridge"}[failure+1], func(t *testing.T) {
			var calls []int
			var operations []stageOperation
			for index := range 6 {
				operations = append(operations, func(context.Context) (json.RawMessage, error) {
					calls = append(calls, index)
					if failure == index {
						return json.RawMessage(`{"observed":"failure"}`), errors.New("controlled failure")
					}
					return json.RawMessage(`{"observed":"success"}`), nil
				})
			}
			stages, err := verifyStages(context.Background(), fakePlan(operations))
			if (err != nil) != (failure >= 0) {
				t.Fatal(err)
			}
			count := 6
			if failure >= 0 {
				count = failure + 1
			}
			if len(calls) != count {
				t.Fatalf("later operations executed: %v", calls)
			}
			for index, stage := range stageList(stages) {
				want := "passed"
				if index == failure {
					want = "failed"
				} else if failure >= 0 && index > failure {
					want = "not_run"
				}
				if stage.Status != want {
					t.Fatalf("stage %d: %+v, want %s", index, stage, want)
				}
			}
			encoded, marshalErr := json.Marshal(stages)
			if marshalErr != nil || !json.Valid(encoded) {
				t.Fatalf("invalid stage report: %s %v", encoded, marshalErr)
			}
		})
	}
}

func TestArcProfileMismatchNeverInvokesConnectionOrRegistration(t *testing.T) {
	sources := endpointFixture(t, "")
	appendLog(t, sources, "DevTools listening on "+testEndpoint+"\n")
	var selected endpoint
	var err error
	forbidden := func(context.Context) (json.RawMessage, error) {
		t.Fatal("connection or native verification ran before isolation")
		return nil, nil
	}
	plan := verificationPlan{
		discover: func(ctx context.Context) (json.RawMessage, error) {
			selected, err = sources.discover(ctx)
			data, _ := json.Marshal(selected)
			return data, err
		},
		isolate: bounded(5*time.Millisecond, func(ctx context.Context) (json.RawMessage, error) {
			_, err := sources.verifyIsolation(ctx, selected)
			return nil, err
		}),
		connect: forbidden, createManifest: forbidden, lookup: forbidden, bridge: forbidden,
	}
	stages, err := verifyStages(context.Background(), plan)
	if err == nil || stages.EndpointDiscovery.Status != "passed" || stages.ProfileIsolation.Status != "failed" ||
		stages.EndpointConnection.Status != "not_run" || stages.ManifestCreation.Status != "not_run" ||
		stages.NativeHostLookup.Status != "not_run" || stages.BridgeConnection.Status != "not_run" {
		t.Fatalf("stages=%+v err=%v", stages, err)
	}
}

func TestArcManifestCreationDoesNotProveLookupOrBridgeConnection(t *testing.T) {
	pass := func(context.Context) (json.RawMessage, error) { return json.RawMessage(`{}`), nil }
	lookup := func(context.Context) (json.RawMessage, error) {
		result := json.RawMessage(`{"error":"Specified native messaging host not found."}`)
		return result, validateNativeReply(result, manifestProof{Location: "isolated", Nonce: "nonce"})
	}
	stages, err := verifyStages(context.Background(), verificationPlan{pass, pass, pass, pass, lookup, pass})
	if err == nil || stages.ManifestCreation.Status != "passed" || stages.NativeHostLookup.Status != "failed" || stages.BridgeConnection.Status != "not_run" {
		t.Fatalf("stages=%+v err=%v", stages, err)
	}
	bridge := func(context.Context) (json.RawMessage, error) {
		result := json.RawMessage(`{"extensionConnected":false}`)
		return result, validateBridgeHealth(result)
	}
	stages, err = verifyStages(context.Background(), verificationPlan{pass, pass, pass, pass, pass, bridge})
	if err == nil || stages.NativeHostLookup.Status != "passed" || stages.BridgeConnection.Status != "failed" {
		t.Fatalf("stages=%+v err=%v", stages, err)
	}
}

func TestArcCancellationDoesNotStartFurtherStages(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	operation := func(context.Context) (json.RawMessage, error) {
		t.Fatal("operation ran after cancellation")
		return nil, nil
	}
	stages, err := verifyStages(ctx, verificationPlan{operation, operation, operation, operation, operation, operation})
	if !errors.Is(err, context.Canceled) || stages.EndpointDiscovery.Status != "failed" {
		t.Fatalf("stages=%+v err=%v", stages, err)
	}
	if !reflect.DeepEqual(stageList(stages)[1:], stageList(initialStages())[1:]) {
		t.Fatal("later stages did not remain explicitly unrun")
	}
}
