package main

import (
	"errors"
	"strings"

	"golang.org/x/sys/unix"
)

// p's own extended attribute names but the ones the OS stamps
// (stampedXattr), a symlink's included.
func listXattrs(p string) ([]string, error) {
	var small [1024]byte
	buf := small[:]
	for {
		n, err := unix.Llistxattr(p, buf)
		// More than fits: ask how much, then read again (it may grow in
		// between).
		if errors.Is(err, unix.ERANGE) {
			size, err := unix.Llistxattr(p, nil)
			if err != nil {
				return nil, err
			}
			buf = make([]byte, size+64)
			continue
		}
		if err != nil {
			return nil, err
		}
		names := []string{}
		for name := range strings.SplitSeq(string(buf[:n]), "\x00") {
			if name != "" && name != stampedXattr {
				names = append(names, name)
			}
		}
		return names, nil
	}
}

// Removes every one of names from p.
func stripXattrs(p string, names []string) error {
	for _, name := range names {
		if err := unix.Lremovexattr(p, name); err != nil && !errors.Is(err, errNoXattr) {
			return err
		}
	}
	return nil
}
