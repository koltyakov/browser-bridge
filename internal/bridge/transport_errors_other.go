//go:build !windows

package bridge

func platformConnectionLost(error) bool { return false }
