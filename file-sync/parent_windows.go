package main

import (
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// Windows keeps a dead parent's pid as this process's parent, so the
// host is waited on through a handle to it instead, which also keeps
// its pid from passing to another process meanwhile.
func watchParent(time.Duration) {
	host, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(os.Getppid()))
	if err != nil {
		hostGone()
	}
	go func() {
		_, _ = windows.WaitForSingleObject(host, windows.INFINITE)
		hostGone()
	}()
}
