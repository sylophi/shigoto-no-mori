//go:build unix

package main

import (
	"errors"

	"golang.org/x/sys/unix"
)

// An errno's name ("ENOENT") and its text.
func errnoOf(err error) (entryError, bool) {
	var errno unix.Errno
	if !errors.As(err, &errno) {
		return entryError{}, false
	}
	return entryError{unix.ErrnoName(errno), errno.Error()}, true
}

func lstat(p string) (statted, error) {
	var st unix.Stat_t
	if err := unix.Lstat(p, &st); err != nil {
		return statted{}, err
	}
	return statted{
		Dev: uint32(st.Dev), Ino: st.Ino, Mode: uint32(st.Mode),
		UID: st.Uid, GID: st.Gid, Size: st.Size,
		CtimeSec: st.Ctim.Sec, CtimeNsec: st.Ctim.Nsec,
		MtimeSec: st.Mtim.Sec, MtimeNsec: st.Mtim.Nsec,
		Flags: statFlags(&st), Blocks: st.Blocks, Nlink: uint32(st.Nlink),
	}, nil
}
