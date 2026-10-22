package bridge

import (
	"context"
	"testing"
)

func TestNativeUpdateUsesAuthenticatedHealthCompatibility(t *testing.T) {
	for _, test := range []struct {
		name      string
		remote    bool
		health    object
		wantCalls int
	}{
		{"disconnected", false, object{"extensionVersion": value("9.0.0")}, 0},
		{"remote", true, object{"extensionConnected": value(true), "extensionVersion": value("1.14.3"), "supported_versions": value([]string{"1.14"})}, 0},
		{"missing protocols", false, object{"extensionConnected": value(true), "extensionVersion": value("1.14.3")}, 0},
		{"extension protocols", false, object{"extensionConnected": value(true), "extensionVersion": value("1.14.3"), "extension_supported_versions": value([]string{"1.14"}), "supported_versions": value([]string{"9.0"})}, 1},
		{"legacy health", false, object{"extensionConnected": value(true), "extensionVersion": value("1.14.3"), "supported_versions": value([]string{"1.14"})}, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			_, err := checkNativeClientUpdate(context.Background(), config{remote: test.remote}, test.health, func(_ context.Context, _ config, version string, protocols []string) (object, error) {
				calls++
				if version != "1.14.3" || len(protocols) != 1 || protocols[0] != "1.14" {
					t.Fatalf("wrong compatibility: %s %v", version, protocols)
				}
				return object{"updated": value(false)}, nil
			})
			if err != nil || calls != test.wantCalls {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestNativeUpdateOffAndRemoteDoNotConnect(t *testing.T) {
	t.Setenv("BBX_AUTO_UPDATE", "off")
	for _, c := range []config{{home: t.TempDir(), network: "invalid"}, {home: t.TempDir(), network: "invalid", remote: true}} {
		forwarded, err := prepareNativeClient(context.Background(), c, []string{"status"})
		if err != nil || forwarded {
			t.Fatalf("disabled update attempted transport: %v", err)
		}
	}
}
