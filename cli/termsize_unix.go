package main

// Terminal width straight from the kernel, no cgo and no x/term
// dependency (the CLI only builds for unix; Windows is unsupported).
// Checked on stdout then stderr so `sm --help | less` still sizes to
// the terminal it renders in.

import (
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

type winsize struct {
	rows, cols, xpixel, ypixel uint16
}

func terminalSize() (int, int) {
	tiocgwinsz := uintptr(0x5413) // linux
	if runtime.GOOS == "darwin" {
		tiocgwinsz = 0x40087468
	}
	var ws winsize
	for _, f := range []*os.File{os.Stdout, os.Stderr} {
		_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), tiocgwinsz, uintptr(unsafe.Pointer(&ws)))
		if errno == 0 && ws.cols > 0 {
			return int(ws.cols), int(ws.rows)
		}
	}
	return 0, 0
}

func terminalWidth() int {
	width, _ := terminalSize()
	return width
}
