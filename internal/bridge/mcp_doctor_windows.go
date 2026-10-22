//go:build windows

package bridge

// Windows access checks reflect the readonly attribute rather than ACL access.
func mcpDoctorUnwritable(string) bool { return false }
