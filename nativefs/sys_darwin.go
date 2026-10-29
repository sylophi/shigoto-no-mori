package main

import (
	"encoding/binary"
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

// a and b trade places in one step, so no reader ever finds either path
// missing: what an update's swap of the app bundle needs. Both must
// exist, on one volume.
func exchange(a, b string) error {
	return unix.RenamexNp(a, b, unix.RENAME_SWAP)
}

// Only APFS clones. HFS+ and network volumes can't.
func cloneable(p string) (bool, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(p, &st); err != nil {
		return false, err
	}
	return unix.ByteSliceToString(st.Fstypename[:]) == "apfs", nil
}

// The flags a checkout's own files can carry (compression, document
// tracking), which no flag read reports.
const keptFlags = unix.UF_COMPRESSED | unix.UF_TRACKED

func statFlags(st *unix.Stat_t) uint32 {
	return st.Flags &^ keptFlags
}

// p's own file flags (st_flags) but keptFlags, a symlink's included.
func fileFlags(p string) (uint32, error) {
	var st unix.Stat_t
	if err := unix.Lstat(p, &st); err != nil {
		return 0, err
	}
	return statFlags(&st), nil
}

// The flags clearing removes: the owner's (immutable, hidden, ...) but
// keptFlags. The system's (an iCloud placeholder, restricted) only root
// may change, so they stay, and asking to drop them would fail the
// whole call.
const clearedFlags = unix.UF_SETTABLE &^ keptFlags

// Clears clearedFlags on p.
func clearFlags(p string) error {
	var st unix.Stat_t
	if err := unix.Lstat(p, &st); err != nil {
		return err
	}
	if st.Flags&clearedFlags == 0 {
		return nil
	}
	return chflagsNoFollow(p, st.Flags&^clearedFlags)
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

// The attribute macOS stamps on whatever this process writes, so
// reads leave it out and stripping leaves it.
const stampedXattr = "com.apple.provenance"

const errNoXattr = unix.ENOATTR

// ATTR_CMNEXT_PRIVATESIZE from <sys/attr.h> (macOS 10.15+), which x/sys
// doesn't define: the bytes of a file no clone shares, i.e. what
// deleting it would free.
const attrCmnextPrivateSize = 0x8

// A file's private size on APFS, via getattrlist(2), which x/sys
// doesn't wrap. ok is false where it can't be read (HFS+ and network
// mounts don't know it), and the caller falls back to the allocated size.
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
	// A volume that doesn't know the attribute may refuse the whole call.
	if errno != 0 {
		return 0, false
	}
	returnedForkAttrs := binary.NativeEndian.Uint32(buf[20:24])
	if returnedForkAttrs&attrCmnextPrivateSize == 0 {
		return 0, false
	}
	return int64(binary.NativeEndian.Uint64(buf[24:32])), true
}
