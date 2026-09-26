//go:build !darwin

package main

import "errors"

// No tree clone call off macOS. cp does the work there, and GNU cp
// (coreutils 9+) already reflinks by default where the filesystem can.
var cloneTree = func(src, dst string) error {
	return errors.ErrUnsupported
}
