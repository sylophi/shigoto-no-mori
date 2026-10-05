package main

import (
	"strings"

	"golang.org/x/sys/unix"
)

// Whether cloneTree can work here at all (a clone checkout is skipped
// up front where it can't).
const treeCloneSupported = true

// clonefile(2) copies a whole tree in one call on APFS, sharing blocks
// with the source until either side writes. NOFOLLOW keeps a symlinked
// entry a symlink, as cp -P does.
var cloneTree = func(src, dst string) error {
	return unix.Clonefile(src, dst, unix.CLONE_NOFOLLOW)
}

// Whether the volume holding p can clone files: APFS (HFS+, exFAT and
// network shares can't, and would only fail at the first clone).
func clonableVolume(p string) bool {
	var st unix.Statfs_t
	return unix.Statfs(p, &st) == nil && unix.ByteSliceToString(st.Fstypename[:]) == "apfs"
}

// Whether a source file carries nothing a checkout wouldn't give it:
// no file flags but compression and document tracking (immutable,
// hidden, an iCloud placeholder), and no extended attributes but the
// provenance macOS stamps on whatever this process writes anyway (a
// quarantine flag would otherwise ride along into the clone).
func plainAsCheckedOut(p string, st *unix.Stat_t) bool {
	if st.Flags&^keptFlags != 0 {
		return false
	}
	extra, err := extraXattrs(p)
	return err == nil && len(extra) == 0
}

// p's extended attributes but the provenance macOS stamps on whatever
// this process writes.
func extraXattrs(p string) ([]string, error) {
	var buf [1024]byte
	n, err := unix.Llistxattr(p, buf[:])
	if err != nil {
		return nil, err
	}
	var extra []string
	for name := range strings.SplitSeq(string(buf[:n]), "\x00") {
		if name != "" && name != "com.apple.provenance" {
			extra = append(extra, name)
		}
	}
	return extra, nil
}

// Flags a clone may keep: the ones a checkout's own files can carry.
const keptFlags = unix.UF_COMPRESSED | unix.UF_TRACKED

// Gives a cloned directory what one git creates would have: the mode,
// no file flags, no extended attributes but provenance.
func normalizeClonedDir(p string, mode uint32) error {
	var st unix.Stat_t
	if err := unix.Lstat(p, &st); err != nil {
		return err
	}
	if st.Flags&^keptFlags != 0 {
		if err := chflagsNoFollow(p, st.Flags&keptFlags); err != nil {
			return err
		}
	}
	if uint32(st.Mode)&0o7777 != mode {
		if err := unix.Chmod(p, mode); err != nil {
			return err
		}
	}
	extra, err := extraXattrs(p)
	if err != nil {
		return err
	}
	for _, name := range extra {
		if err := unix.Lremovexattr(p, name); err != nil {
			return err
		}
	}
	return nil
}

// Makes whatever a clone left at p removable: no flags that pin it,
// directories that can be listed and emptied.
func unpin(p string) {
	var st unix.Stat_t
	if unix.Lstat(p, &st) != nil {
		return
	}
	if st.Flags&^keptFlags != 0 {
		_ = chflagsNoFollow(p, st.Flags&keptFlags)
	}
	if st.Mode&unix.S_IFMT == unix.S_IFDIR {
		_ = unix.Chmod(p, 0o700)
	}
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
