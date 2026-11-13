package main

import (
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The errno names callers read, for the Windows errors that mean them,
// as Node names them.
var errnoNames = map[windows.Errno]string{
	windows.ERROR_FILE_NOT_FOUND: "ENOENT",
	windows.ERROR_PATH_NOT_FOUND: "ENOENT",
	windows.ERROR_ACCESS_DENIED:  "EPERM",
	windows.ERROR_ALREADY_EXISTS: "EEXIST",
	windows.ERROR_NOT_SUPPORTED:  "ENOTSUP",
}

func errnoOf(err error) (entryError, bool) {
	var errno windows.Errno
	if !errors.As(err, &errno) {
		return entryError{}, false
	}
	return entryError{errnoNames[errno], errno.Error()}, true
}

// ReFS and Dev Drive can share blocks, which isn't used here, so no
// volume clones.
func cloneable(string) (bool, error) { return false, nil }

// Fails as a clone does where the volume can't clone, a destination
// that's there refused as such first: callers clear what a failed
// clone left at it.
func cloneTree(_, dst string) error {
	if _, err := os.Lstat(dst); err == nil {
		return windows.ERROR_ALREADY_EXISTS
	}
	return windows.ERROR_NOT_SUPPORTED
}

// Windows can't swap two paths in one step.
func exchange(_, _ string) error { return windows.ERROR_NOT_SUPPORTED }

// Never asked, as no volume clones.
func privateSize(string) (int64, bool) { return 0, false }

// NTFS's extended attributes and alternate streams aren't read.
func listXattrs(string) ([]string, error) { return nil, windows.ERROR_NOT_SUPPORTED }

func stripXattrs(string, []string) error { return windows.ERROR_NOT_SUPPORTED }

// File flags are a clone's concern, and no volume clones.
func clearFlags(string) error { return windows.ERROR_NOT_SUPPORTED }

// FILE_STANDARD_INFO and FILE_ATTRIBUTE_TAG_INFO from <winbase.h>,
// which x/sys doesn't define.
type fileStandardInfo struct {
	AllocationSize, EndOfFile int64
	NumberOfLinks             uint32
	DeletePending, Directory  uint8
}

type fileAttributeTagInfo struct {
	FileAttributes, ReparseTag uint32
}

// p's own, read through a handle that asks no access, so a file open
// elsewhere or unreadable still answers. Windows owners are SIDs, so
// uid and gid are 0, and ctime is the creation time, as git for Windows
// records it.
func lstat(p string) (statted, error) {
	name, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return statted{}, err
	}
	h, err := windows.CreateFile(name, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return statted{}, err
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return statted{}, err
	}
	var std fileStandardInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileStandardInfo,
		(*byte)(unsafe.Pointer(&std)), uint32(unsafe.Sizeof(std))); err != nil {
		return statted{}, err
	}
	// A junction is a link too, as git and Node take it.
	link := false
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		var tag fileAttributeTagInfo
		if err := windows.GetFileInformationByHandleEx(h, windows.FileAttributeTagInfo,
			(*byte)(unsafe.Pointer(&tag)), uint32(unsafe.Sizeof(tag))); err != nil {
			return statted{}, err
		}
		link = tag.ReparseTag == windows.IO_REPARSE_TAG_SYMLINK ||
			tag.ReparseTag == windows.IO_REPARSE_TAG_MOUNT_POINT
	}
	// The permissions Go's own stat gives: read-only or not.
	mode := uint32(0o666)
	if info.FileAttributes&windows.FILE_ATTRIBUTE_READONLY != 0 {
		mode = 0o444
	}
	switch {
	case link:
		mode |= sIFLNK
	case info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0:
		mode |= sIFDIR | 0o111
	default:
		mode |= sIFREG
	}
	ctimeSec, ctimeNsec := unixTime(info.CreationTime)
	mtimeSec, mtimeNsec := unixTime(info.LastWriteTime)
	return statted{
		Dev: info.VolumeSerialNumber,
		// The file's record number, without the sequence number in the
		// top 16 bits: with it, the number is past what JSON's readers hold.
		Ino:      (uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow)) & (1<<48 - 1),
		Mode:     mode,
		Size:     std.EndOfFile,
		CtimeSec: ctimeSec, CtimeNsec: ctimeNsec,
		MtimeSec: mtimeSec, MtimeNsec: mtimeNsec,
		Blocks: std.AllocationSize / 512,
		Nlink:  info.NumberOfLinks,
	}, nil
}

func unixTime(ft windows.Filetime) (int64, int64) {
	ns := ft.Nanoseconds()
	return ns / 1e9, ns % 1e9
}
