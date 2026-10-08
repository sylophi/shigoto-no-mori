//go:build darwin

package main

import (
	"encoding/binary"
	"errors"
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

// Clears every flag on p but keptFlags (immutable, hidden, an iCloud
// placeholder), given the flags it has now.
func clearFlags(p string, flags uint32) error {
	if flags&^keptFlags == 0 {
		return nil
	}
	return chflagsNoFollow(p, flags&keptFlags)
}

// chflags on p itself, a symlink included (chflags(2) follows one).
func chflagsNoFollow(p string, flags uint32) error {
	fd, err := unix.Open(p, unix.O_RDONLY|unix.O_SYMLINK|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	return unix.Fchflags(fd, int(flags))
}

// p's own extended attribute names, a symlink's included.
func listXattrs(p string) ([]string, error) {
	for {
		size, err := unix.Llistxattr(p, nil)
		if err != nil || size == 0 {
			return nil, err
		}
		buf := make([]byte, size)
		n, err := unix.Llistxattr(p, buf)
		// Grew between the two calls.
		if errors.Is(err, unix.ERANGE) {
			continue
		}
		if err != nil {
			return nil, err
		}
		var names []string
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
func privateSize(path string) (int64, bool) {
	p, err := syscall.BytePtrFromString(path)
	if err != nil {
		return 0, false
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
	if errno != 0 {
		return 0, false
	}
	returnedForkAttrs := binary.NativeEndian.Uint32(buf[20:24])
	if returnedForkAttrs&attrCmnextPrivateSize == 0 {
		return 0, false
	}
	return int64(binary.NativeEndian.Uint64(buf[24:32])), true
}
