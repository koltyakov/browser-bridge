package bridge

type browserDefinition struct {
	key, macDir, windowsDir, linuxDir, registry string
}

type nativePlatformDefinition struct {
	key, goos, goarch, asset string
}

// Data comes from protocol/install-targets.json through checked-in generation.
var installBrowsers = func() []string {
	keys := make([]string, 0, len(browserRegistry))
	for _, browser := range browserRegistry {
		keys = append(keys, browser.key)
	}
	return keys
}()

func installBrowserByKey(key string) *browserDefinition {
	for i := range browserRegistry {
		if browserRegistry[i].key == key {
			return &browserRegistry[i]
		}
	}
	return nil
}
