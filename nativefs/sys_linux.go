package main

import (
	"cmp"
	"encoding/binary"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/unix"
)

// A clone of src at dst as clonefile(2) makes one on macOS: a folder's
// whole tree, each regular file's blocks shared with the source
// (FICLONE) until either side writes, a symlink kept a symlink, and
// each entry's mode and times kept. Linux clones file by file, so a
// folder's entries share a pool of goroutines. Anything but a folder,
// a regular file or a symlink can't be cloned.
func cloneTree(src, dst string) error {
	c := cloner{slots: make(chan struct{}, runtime.NumCPU()*2)}
	return c.clone(src, dst)
}

type cloner struct {
	// An entry gets a goroutine of its own while a slot is free, and is
	// cloned on the caller's otherwise, so a deep tree never waits on
	// itself.
	slots chan struct{}
}

func (c *cloner) clone(src, dst string) error {
	var st unix.Stat_t
	if err := unix.Lstat(src, &st); err != nil {
		return err
	}
	switch st.Mode & unix.S_IFMT {
	case unix.S_IFREG:
		return cloneFile(src, dst, &st)
	case unix.S_IFLNK:
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		if err := unix.Symlink(target, dst); err != nil {
			return err
		}
		return keepTimes(dst, &st)
	case unix.S_IFDIR:
		return c.cloneDir(src, dst, &st)
	}
	return unix.EOPNOTSUPP
}

func cloneFile(src, dst string, st *unix.Stat_t) error {
	in, err := unix.Open(src, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(in)
	out, err := unix.Open(dst, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	err = unix.IoctlFileClone(out, in)
	if err == nil {
		err = unix.Fchmod(out, st.Mode&0o7777)
	}
	if closeErr := unix.Close(out); err == nil {
		err = closeErr
	}
	if err == nil {
		err = keepTimes(dst, st)
	}
	if err != nil {
		_ = unix.Unlink(dst)
	}
	return err
}

func (c *cloner) cloneDir(src, dst string, st *unix.Stat_t) error {
	// Writable until its entries are in, then the source's mode and times,
	// which adding them would have moved.
	if err := unix.Mkdir(dst, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var first error
	note := func(err error) {
		if err != nil {
			mu.Lock()
			first = cmp.Or(first, err)
			mu.Unlock()
		}
	}
	for _, entry := range entries {
		from, to := filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name())
		select {
		case c.slots <- struct{}{}:
			wg.Go(func() {
				defer func() { <-c.slots }()
				note(c.clone(from, to))
			})
		default:
			note(c.clone(from, to))
		}
	}
	wg.Wait()
	if first != nil {
		return first
	}
	if err := unix.Fchmodat(unix.AT_FDCWD, dst, st.Mode&0o7777, 0); err != nil {
		return err
	}
	return keepTimes(dst, st)
}

// p's access and modification times as st has them, a symlink's own.
func keepTimes(p string, st *unix.Stat_t) error {
	return unix.UtimesNanoAt(unix.AT_FDCWD, p, []unix.Timespec{st.Atim, st.Mtim}, unix.AT_SYMLINK_NOFOLLOW)
}

// a and b trade places in one step, so no reader ever finds either path
// missing. Both must exist, on one filesystem.
func exchange(a, b string) error {
	return unix.Renameat2(unix.AT_FDCWD, a, unix.AT_FDCWD, b, unix.RENAME_EXCHANGE)
}

// btrfs clones, and XFS when it was made with reflink (mkfs.xfs's
// default since xfsprogs 5.1). ext4, tmpfs and network mounts can't.
func cloneable(p string) (bool, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(p, &st); err != nil {
		return false, err
	}
	switch st.Type {
	case unix.BTRFS_SUPER_MAGIC:
		return true, nil
	case unix.XFS_SUPER_MAGIC:
		return xfsReflink(p)
	}
	return false, nil
}

// XFS_IOC_FSGEOMETRY_V4 from <xfs/xfs_fs.h>, which x/sys doesn't
// define: _IOR('X', 124, struct xfs_fsop_geom_v4), 112 bytes, whose
// flags word at 92 says whether the filesystem shares blocks.
const (
	xfsIocFsgeometryV4  = 0x8070587c
	xfsGeomFlagsReflink = 1 << 20
)

func xfsReflink(p string) (bool, error) {
	fd, err := unix.Open(p, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return false, err
	}
	defer unix.Close(fd)
	var geom [112]byte
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), xfsIocFsgeometryV4, uintptr(unsafe.Pointer(&geom[0])))
	if errno != 0 {
		return false, errno
	}
	return binary.NativeEndian.Uint32(geom[92:96])&xfsGeomFlagsReflink != 0, nil
}

// Linux has no flags a checkout's files could be left with (chattr's
// immutable and append-only only root may set), so none are reported.
func statFlags(*unix.Stat_t) uint32 { return 0 }

func fileFlags(p string) (uint32, error) {
	var st unix.Stat_t
	return 0, unix.Lstat(p, &st)
}

func clearFlags(string) error { return nil }

// The attribute SELinux labels whatever this process writes with, so
// reads leave it out and stripping leaves it.
const stampedXattr = "security.selinux"

const errNoXattr = unix.ENODATA

// FS_IOC_FIEMAP from <linux/fs.h>, and the layout of <linux/fiemap.h>'s
// structs, which x/sys doesn't define: a 32-byte header (start, length,
// flags, mapped count, extent count) and 56-byte extents (logical,
// physical, length, reserved, flags).
const (
	fsIocFiemap        = 0xc020660b
	fiemapExtentLast   = 0x1
	fiemapExtentShared = 0x2000
	fiemapHeaderSize   = 32
	fiemapExtentSize   = 56
	fiemapExtents      = 64
)

// A file's private size: its extents' bytes that FIEMAP doesn't mark
// shared with a clone. A write to a shared extent counts as shared until
// it is written back. ok is false where the filesystem can't map extents
// (tmpfs, network mounts), and the caller falls back to the allocated
// size.
func privateSize(path string) (int64, bool) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return 0, false
	}
	defer unix.Close(fd)
	var buf [fiemapHeaderSize + fiemapExtents*fiemapExtentSize]byte
	var private int64
	var start uint64
	for {
		clear(buf[:])
		binary.NativeEndian.PutUint64(buf[0:], start)
		binary.NativeEndian.PutUint64(buf[8:], ^uint64(0))
		binary.NativeEndian.PutUint32(buf[24:], fiemapExtents)
		_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), fsIocFiemap, uintptr(unsafe.Pointer(&buf[0])))
		if errno != 0 {
			return 0, false
		}
		mapped := binary.NativeEndian.Uint32(buf[20:24])
		if mapped == 0 {
			return private, true
		}
		for i := range int(mapped) {
			extent := buf[fiemapHeaderSize+i*fiemapExtentSize:]
			logical := binary.NativeEndian.Uint64(extent[0:8])
			length := binary.NativeEndian.Uint64(extent[16:24])
			flags := binary.NativeEndian.Uint32(extent[40:44])
			if flags&fiemapExtentShared == 0 {
				private += int64(length)
			}
			if flags&fiemapExtentLast != 0 {
				return private, true
			}
			start = logical + length
		}
	}
}
