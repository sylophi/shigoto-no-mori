//go:build unix

package main

import (
	"os"
	"time"
)

// When the host dies, the kernel reparents this process (to launchd or
// init), so a changed parent pid is the host being gone. Polled,
// because macOS has no parent-death signal.
func watchParent(interval time.Duration) {
	parent := os.Getppid()
	go func() {
		for {
			time.Sleep(interval)
			if os.Getppid() != parent {
				hostGone()
			}
		}
	}()
}
