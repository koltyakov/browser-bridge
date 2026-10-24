//go:build windows

package bridge

// Windows replacement keeps the destination's ACL-based access for the user.
func installOwnedByCurrentUser(string) bool { return true }
