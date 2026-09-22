package main

import "golang.org/x/sys/unix"

// clonefile(2) copies a whole tree in one call on APFS, sharing blocks
// with the source until either side writes. NOFOLLOW keeps a symlinked
// entry a symlink, as cp -P does.
var cloneTree = func(src, dst string) error {
	return unix.Clonefile(src, dst, unix.CLONE_NOFOLLOW)
}
