package main

import (
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// Windows keeps a dead parent's pid as this process's parent, which
// another process born since may hold. So the host is the process there
// only if it was born first, and is waited on through a handle to it,
// which keeps its pid from passing on meanwhile.
func watchParent(time.Duration) {
	host, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(os.Getppid()))
	if err != nil || born(host) >= born(windows.CurrentProcess()) {
		hostGone()
	}
	go func() {
		_, _ = windows.WaitForSingleObject(host, windows.INFINITE)
		hostGone()
	}()
}

func born(process windows.Handle) int64 {
	var created, exited, kernel, user windows.Filetime
	_ = windows.GetProcessTimes(process, &created, &exited, &kernel, &user)
	return created.Nanoseconds()
}
