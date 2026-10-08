//go:build darwin

package main

import (
	"encoding/binary"
	"errors"
	"os"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// clonefile(2) copies a whole tree in one call on APFS, sharing blocks
// with the source until either side writes, and keeps each entry's
// mode and mtime. NOFOLLOW keeps a symlinked entry a symlink, as cp -P
// does.
func cloneTree(src, dst string) error {
	return unix.Clonefile(src, dst, unix.CLONE_NOFOLLOW)
}

// The name of the filesystem holding p: "apfs", "hfs", "smbfs", ...
func fsType(p string) (string, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(p, &st); err != nil {
		return "", err
	}
	return unix.ByteSliceToString(st.Fstypename[:]), nil
}

// p's own file flags (st_flags), a symlink's included.
func fileFlags(p string) (uint32, error) {
	var st unix.Stat_t
	if err := unix.Lstat(p, &st); err != nil {
		return 0, err
	}
	return st.Flags, nil
}

// Flags clearing leaves: the ones a checkout's own files can carry.
const keptFlags = unix.UF_COMPRESSED | unix.UF_TRACKED

// The flags clearing removes: the owner's (immutable, hidden, ...) but
// keptFlags. The system's (an iCloud placeholder, restricted) only root
// may change, so they stay, and asking to drop them would fail the
// whole call.
const clearedFlags = unix.UF_SETTABLE &^ keptFlags

// Clears clearedFlags on p, given the flags it has now.
func clearFlags(p string, flags uint32) error {
	if flags&clearedFlags == 0 {
		return nil
	}
	return chflagsNoFollow(p, flags&^clearedFlags)
}

// chflags on p itself, a symlink included (chflags(2) follows one),
// without opening it: a fifo would block, and a file the owner can't
// read still takes its owner's flags.
func chflagsNoFollow(p string, flags uint32) error {
	attrs := unix.Attrlist{
		Bitmapcount: unix.ATTR_BIT_MAP_COUNT,
		Commonattr:  unix.ATTR_CMN_FLAGS,
	}
	var buf [4]byte
	binary.NativeEndian.PutUint32(buf[:], flags)
	return unix.Setattrlist(p, &attrs, buf[:], unix.FSOPT_NOFOLLOW)
}

// p's own extended attribute names, a symlink's included.
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
			if name != "" {
				names = append(names, name)
			}
		}
		return names, nil
	}
}

// The attribute macOS stamps on whatever this process writes, so
// stripping leaves it.
const provenanceXattr = "com.apple.provenance"

// Removes every one of names from p but provenanceXattr.
func stripXattrs(p string, names []string) error {
	for _, name := range names {
		if name == provenanceXattr {
			continue
		}
		if err := unix.Lremovexattr(p, name); err != nil && !errors.Is(err, unix.ENOATTR) {
			return err
		}
	}
	return nil
}

// ATTR_CMNEXT_PRIVATESIZE from <sys/attr.h> (macOS 10.15+), which x/sys
// doesn't define: the bytes of a file no clone shares, i.e. what
// deleting it would free.
const attrCmnextPrivateSize = 0x8

// A file's private size on APFS, via getattrlist(2), which x/sys
// doesn't wrap. ok is false where the volume can't say (HFS+, a network
// mount), and the caller falls back to the allocated size.
func privateSize(path string) (int64, bool, error) {
	p, err := syscall.BytePtrFromString(path)
	if err != nil {
		return 0, false, err
	}
	attrs := unix.Attrlist{
		Bitmapcount: unix.ATTR_BIT_MAP_COUNT,
		Commonattr:  unix.ATTR_CMN_RETURNED_ATTRS,
		Forkattr:    attrCmnextPrivateSize,
	}
	// u_int32_t length, attribute_set_t returned (five u_int32_t), then
	// the off_t.
	var buf [32]byte
	_, _, errno := syscall.Syscall6(syscall.SYS_GETATTRLIST,
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&attrs)),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(len(buf)),
		uintptr(unix.FSOPT_NOFOLLOW|unix.FSOPT_ATTR_CMN_EXTENDED),
		0)
	// A volume that doesn't know the attribute may refuse the whole call.
	if errno == unix.EINVAL || errno == unix.ENOTSUP {
		return 0, false, nil
	}
	if errno != 0 {
		return 0, false, &os.PathError{Op: "getattrlist", Path: path, Err: errno}
	}
	returnedForkAttrs := binary.NativeEndian.Uint32(buf[20:24])
	if returnedForkAttrs&attrCmnextPrivateSize == 0 {
		return 0, false, nil
	}
	return int64(binary.NativeEndian.Uint64(buf[24:32])), true, nil
}
