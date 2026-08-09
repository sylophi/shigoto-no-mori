//go:build linux

package main

// Raw-mode termios plumbing, kernel struct layout. The CLI only ships
// on macOS; this keeps a linux build working for development.

import (
	"os"
	"syscall"
	"unsafe"
)

type termios struct {
	iflag, oflag, cflag, lflag uint32
	line                       uint8
	cc                         [19]uint8
}

const (
	ioctlGetTermios = 0x5401 // TCGETS
	ioctlSetTermios = 0x5402 // TCSETS

	flagICANON = 0x0002
	flagECHO   = 0x0008
	flagISIG   = 0x0001

	ccVMIN  = 6
	ccVTIME = 5
)

func getTermios(f *os.File) (termios, error) {
	var t termios
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), ioctlGetTermios, uintptr(unsafe.Pointer(&t)))
	if errno != 0 {
		return t, errno
	}
	return t, nil
}

func setTermios(f *os.File, t termios) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), ioctlSetTermios, uintptr(unsafe.Pointer(&t)))
	if errno != 0 {
		return errno
	}
	return nil
}

// True when a byte is readable within ms -- distinguishes a lone ESC
// keypress from a split escape sequence.
func waitReadable(f *os.File, ms int) bool {
	fd := int(f.Fd())
	var set syscall.FdSet
	set.Bits[fd/64] |= 1 << (uint(fd) % 64)
	tv := syscall.Timeval{Usec: int64(ms * 1000)}
	n, err := syscall.Select(fd+1, &set, nil, nil, &tv)
	return err == nil && n > 0
}
