package main

import (
	"encoding/binary"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

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
