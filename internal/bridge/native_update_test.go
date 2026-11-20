package bridge

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestExtensionIdentityTriggersUpdateAndReplacement(t *testing.T) {
	for _, test := range []struct {
		name                      string
		protocols                 []string
		updated                   bool
		updateErr                 error
		wantUpdates, wantRestarts int
	}{
		{"new release", []string{"2.2"}, true, nil, 1, 1},
		{"no release", []string{"2.2"}, false, nil, 1, 0},
		{"verification failure", []string{"2.2"}, false, errors.New("bad signature"), 1, 0},
		{"legacy identity", nil, false, nil, 0, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			updates, restarts := 0, 0
			identity := object{"extensionVersion": value("2.2.1"), "supported_versions": value(test.protocols)}
			checkExtensionNativeUpdate(context.Background(), config{}, identity,
				func(_ context.Context, _ config, extension string, supported []string) (object, error) {
					updates++
					if extension != "2.2.1" || len(supported) != 1 || supported[0] != "2.2" {
						t.Fatal(extension, supported)
					}
					return object{"updated": value(test.updated), "executable": value("/verified/bbx")}, test.updateErr
				},
				func(_ config, executable string) error {
					restarts++
					if executable != "/verified/bbx" {
						t.Fatal(executable)
					}
					return nil
				})
			if updates != test.wantUpdates || restarts != test.wantRestarts {
				t.Fatal(updates, restarts)
			}
		})
	}
}

func TestPeriodicNativeUpdateChecksWithoutExtensionEvents(t *testing.T) {
	ticks := make(chan time.Time, 3)
	for i := 0; i < 3; i++ {
		ticks <- time.Now()
	}
	close(ticks)
	checks, restarts := 0, 0
	periodicNativeUpdates(context.Background(), config{}, ticks,
		func(_ context.Context, _ config, extension string, protocols []string) (object, error) {
			checks++
			if extension != "" || len(protocols) != 0 {
				t.Fatal("periodic check required a connected browser", extension, protocols)
			}
			if checks == 1 {
				return nil, errors.New("offline")
			}
			return object{"updated": value(checks == 2), "executable": value("/verified/bbx")}, nil
		},
		func(_ config, executable string) error {
			restarts++
			if executable != "/verified/bbx" {
				t.Fatal(executable)
			}
			return nil
		})
	if checks != 3 || restarts != 1 {
		t.Fatal(checks, restarts)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	periodicNativeUpdates(ctx, config{}, make(chan time.Time), func(context.Context, config, string, []string) (object, error) {
		t.Fatal("check after shutdown")
		return nil, nil
	}, nil)
}
