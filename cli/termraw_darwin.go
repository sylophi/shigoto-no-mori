//go:build darwin

package main

// Raw-mode termios plumbing for the arrow-key menus, macOS layout.
// Canonical mode and echo go off so keys arrive unbuffered; ISIG goes
// off too so ctrl-c reaches the menu as a byte and cancels cleanly
// with the terminal already restored.

import (
	"os"
	"syscall"
	"unsafe"
)

type termios struct {
	iflag, oflag, cflag, lflag uint64
	cc                         [20]uint8
	ispeed, ospeed             uint64
}

const (
	ioctlGetTermios = 0x40487413 // TIOCGETA
	ioctlSetTermios = 0x80487414 // TIOCSETA

	flagICANON = 0x00000100
	flagECHO   = 0x00000008
	flagISIG   = 0x00000080

	ccVMIN  = 16
	ccVTIME = 17
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
	set.Bits[fd/32] |= 1 << (uint(fd) % 32)
	tv := syscall.Timeval{Usec: int32(ms * 1000)}
	if err := syscall.Select(fd+1, &set, nil, nil, &tv); err != nil {
		return false
	}
	return set.Bits[fd/32]&(1<<(uint(fd)%32)) != 0
}
