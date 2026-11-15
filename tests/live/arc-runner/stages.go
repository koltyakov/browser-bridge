package main

import (
	"context"
	"encoding/json"
	"fmt"
)

type stageResult struct {
	Status   string          `json:"status"`
	Evidence json.RawMessage `json:"evidence,omitempty"`
	Error    string          `json:"error,omitempty"`
}

type verificationStages struct {
	EndpointDiscovery  stageResult `json:"endpointDiscovery"`
	ProfileIsolation   stageResult `json:"profileIsolation"`
	EndpointConnection stageResult `json:"endpointConnection"`
	ManifestCreation   stageResult `json:"manifestCreation"`
	NativeHostLookup   stageResult `json:"nativeHostLookup"`
	BridgeConnection   stageResult `json:"bridgeConnection"`
}

type stageOperation func(context.Context) (json.RawMessage, error)

type verificationPlan struct {
	discover, isolate, connect, createManifest, lookup, bridge stageOperation
}

func verifyStages(ctx context.Context, plan verificationPlan) (verificationStages, error) {
	stages := initialStages()
	steps := []struct {
		name string
		run  stageOperation
		out  *stageResult
	}{
		{"endpoint discovery", plan.discover, &stages.EndpointDiscovery},
		{"profile isolation", plan.isolate, &stages.ProfileIsolation},
		{"endpoint connection", plan.connect, &stages.EndpointConnection},
		{"manifest creation", plan.createManifest, &stages.ManifestCreation},
		{"native-host lookup", plan.lookup, &stages.NativeHostLookup},
		{"bridge connection", plan.bridge, &stages.BridgeConnection},
	}
	for _, step := range steps {
		err := ctx.Err()
		if err == nil {
			if step.run == nil {
				err = fmt.Errorf("missing verification operation")
			} else {
				step.out.Evidence, err = step.run(ctx)
			}
		}
		if err != nil {
			step.out.Status, step.out.Error = "failed", err.Error()
			return stages, fmt.Errorf("%s: %w", step.name, err)
		}
		step.out.Status = "passed"
	}
	return stages, nil
}

func initialStages() verificationStages {
	notRun := stageResult{Status: "not_run"}
	return verificationStages{notRun, notRun, notRun, notRun, notRun, notRun}
}
