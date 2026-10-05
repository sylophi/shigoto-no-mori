//go:build !darwin

package main

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

const treeCloneSupported = false

// No tree clone call off macOS. cp does the work there, and GNU cp
// (coreutils 9+) already reflinks by default where the filesystem can.
var cloneTree = func(src, dst string) error {
	return errors.ErrUnsupported
}

func plainAsCheckedOut(string, *unix.Stat_t) bool { return true }

func normalizeClonedDir(p string, mode uint32) error { return unix.Chmod(p, mode) }

func unpin(p string) {
	if info, err := os.Lstat(p); err == nil && info.IsDir() {
		_ = os.Chmod(p, 0o700)
	}
}

func clonableVolume(string) bool { return false }
