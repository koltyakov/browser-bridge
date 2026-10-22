package bridge

import "testing"

func TestVersionName(t *testing.T) {
	original := developmentHash
	t.Cleanup(func() { developmentHash = original })
	for _, hash := range []string{"", "a1b2c3d4"} {
		developmentHash = hash
		want := version
		if hash != "" {
			want += "-dev." + hash
		}
		if got := versionName(); got != want {
			t.Fatalf("versionName() = %q, want %q", got, want)
		}
		d := serviceTestDaemon(t)
		health := d.health(object{"daemonVersionName": value("forged")})
		if health.text("daemonVersion") != version || health.text("daemonVersionName") != want {
			t.Fatalf("unexpected health version metadata: %s", value(health))
		}
	}
}
