package bridge

// Set by development Make targets, not release packaging.
var developmentHash string

func versionName() string {
	if developmentHash != "" {
		return version + "-dev." + developmentHash
	}
	return version
}
