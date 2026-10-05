package main

// sm disk-usage: the tidy page's measurement of one worktree directory.
// App plumbing, not in the help catalog: the host hands it a path and
// the nested worktrees to step over, and caches the result.
//
// Two totals come back. `bytes` is the footprint, what `du` reports:
// allocated blocks, each inode once. `reclaimableBytes` is what removing
// the tree would actually free, which is usually far less: pnpm imports
// packages as APFS clones of its store (or hard links, where the
// filesystem can't clone), and carry-over clones from the primary
// checkout, so most of a node_modules shares its blocks with copies
// outside the worktree. A hard-linked inode counts only when every one
// of its links is inside the tree, and on macOS each inode counts only
// its private blocks, the ones no clone shares (see privateSize).

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

// Names whose contents are real disk usage but not evidence that anyone
// touched the worktree. A fresh `pnpm install` rewrites every mtime
// under node_modules, which would otherwise make an abandoned worktree
// look like it was worked on minutes ago.
//
// Matched against files as well as directories, which matters most for
// ".git": in a linked worktree that is a gitdir *pointer file* stamped
// at creation time, so counting it would make every worktree in the
// project look freshly active.
var activityExcludedNames = map[string]bool{
	".git":          true,
	".shigomori":    true,
	"node_modules":  true,
	".venv":         true,
	"venv":          true,
	"vendor":        true,
	"dist":          true,
	"build":         true,
	"out":           true,
	"target":        true,
	".next":         true,
	".nuxt":         true,
	".turbo":        true,
	".cache":        true,
	".parcel-cache": true,
	"coverage":      true,
	"__pycache__":   true,
}

// How many directories are read at once, and so how many readers the
// walk runs. Enough to keep the disk busy without risking EMFILE on a
// deep tree. The walk is IO-bound, so going
// wider stops helping well before this.
const diskUsageReaders = 8

type diskUsage struct {
	Bytes            int64 `json:"bytes"`
	ReclaimableBytes int64 `json:"reclaimableBytes"`
	// Newest mtime (epoch ms) outside activityExcludedNames, or nil when
	// nothing datable was found.
	LastActivityAt *int64 `json:"lastActivityAt"`
	// True when at least one entry couldn't be read, making both totals
	// floors rather than exact figures.
	Partial bool `json:"partial"`
}

type inodeKey struct{ dev, ino uint64 }

// A multiply-linked inode seen during the walk. Counted at the end, once,
// and toward reclaimableBytes only if the walk met all of its links.
type linkedInode struct {
	path        string
	nlink, seen uint64
	bytes       int64
}

// What deleting a file of `allocated` bytes would free: its private
// blocks where the platform can tell (APFS), else all of them.
func ownBytes(path string, allocated int64) int64 {
	if allocated == 0 {
		return 0
	}
	if private, ok := privateSize(path); ok {
		return min(private, allocated)
	}
	return allocated
}

// A directory waiting to be read. countsAsActivity turns false below an
// activityExcludedNames directory: everything there still counts toward
// the totals but never toward LastActivityAt.
type pendingDir struct {
	path             string
	countsAsActivity bool
}

// Measures root recursively. Never follows symlinks (a link into a
// sibling worktree would double-count, and a cycle would hang), and
// never fails: unreadable entries are skipped and flagged via Partial
// so the caller can show an approximate total instead of an error.
// exclude holds absolute directory paths to step over entirely: the
// in-project layout puts a project's worktrees inside its primary
// checkout, and each of those is measured as its own row.
//
// A fixed pool of readers drains a shared stack of directories. A
// reader finding the stack empty waits while any other is still reading
// (that one may be about to push more), and all of them leave once the
// stack is empty with nobody reading.
func measureDiskUsage(root string, exclude map[string]bool) diskUsage {
	var (
		mu      sync.Mutex
		changed = sync.NewCond(&mu)
		pending = []pendingDir{{path: filepath.Clean(root), countsAsActivity: true}}
		reading int
		usage   diskUsage
		linked  = map[inodeKey]*linkedInode{}
		wg      sync.WaitGroup
	)

	// Measures one directory: its own blocks and its files, and returns
	// the subdirectories to read next.
	readDir := func(dir pendingDir) []pendingDir {
		var (
			bytes, reclaimable int64
			newest             *int64
			partial            bool
			subdirs            []pendingDir
		)
		// A directory's own blocks: 0 on APFS, a block or more on ext4.
		if info, err := os.Lstat(dir.path); err == nil {
			allocated := info.Sys().(*syscall.Stat_t).Blocks * 512
			bytes += allocated
			reclaimable += allocated
		}
		var entries []fs.DirEntry
		f, err := os.Open(dir.path)
		if err == nil {
			// Unsorted, unlike os.ReadDir: nothing here needs the order.
			entries, err = f.ReadDir(-1)
			f.Close()
		}
		partial = err != nil
		for _, entry := range entries {
			path := filepath.Join(dir.path, entry.Name())
			if entry.IsDir() {
				if !exclude[path] {
					subdirs = append(subdirs, pendingDir{
						path:             path,
						countsAsActivity: dir.countsAsActivity && !activityExcludedNames[entry.Name()],
					})
				}
				continue
			}
			regular := entry.Type().IsRegular()
			if !regular && entry.Type()&fs.ModeSymlink == 0 {
				continue
			}
			info, err := os.Lstat(path)
			if err != nil {
				partial = true
				continue
			}
			st := info.Sys().(*syscall.Stat_t)
			allocated := st.Blocks * 512
			// Symlinks are counted as themselves, never their target, and
			// never as activity.
			if regular && dir.countsAsActivity && !activityExcludedNames[entry.Name()] {
				mtime := info.ModTime().UnixMilli()
				if newest == nil || mtime > *newest {
					newest = &mtime
				}
			}
			if uint64(st.Nlink) > 1 {
				key := inodeKey{uint64(st.Dev), uint64(st.Ino)}
				mu.Lock()
				inode := linked[key]
				if inode == nil {
					inode = &linkedInode{path: path, nlink: uint64(st.Nlink), bytes: allocated}
					linked[key] = inode
				}
				inode.seen++
				mu.Unlock()
				continue
			}
			bytes += allocated
			reclaimable += ownBytes(path, allocated)
		}

		mu.Lock()
		usage.Bytes += bytes
		usage.ReclaimableBytes += reclaimable
		usage.Partial = usage.Partial || partial
		if newest != nil && (usage.LastActivityAt == nil || *newest > *usage.LastActivityAt) {
			usage.LastActivityAt = newest
		}
		mu.Unlock()
		return subdirs
	}

	for range diskUsageReaders {
		wg.Go(func() {
			mu.Lock()
			defer mu.Unlock()
			for {
				for len(pending) == 0 && reading > 0 {
					changed.Wait()
				}
				if len(pending) == 0 {
					return
				}
				dir := pending[len(pending)-1]
				pending = pending[:len(pending)-1]
				reading++
				mu.Unlock()
				subdirs := readDir(dir)
				mu.Lock()
				pending = append(pending, subdirs...)
				reading--
				changed.Broadcast()
			}
		})
	}
	wg.Wait()

	for _, inode := range linked {
		usage.Bytes += inode.bytes
		if inode.seen >= inode.nlink {
			usage.ReclaimableBytes += ownBytes(inode.path, inode.bytes)
		}
	}
	return usage
}

func cmdDiskUsage(_ cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		lists: map[string][]string{"exclude": {}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	if len(parsed.positionals) != 1 {
		return 2, usageErrf("Usage: %s disk-usage <path> [--exclude <path>...]", binaryName)
	}
	exclude := map[string]bool{}
	for _, path := range parsed.lists["exclude"] {
		exclude[filepath.Clean(toAbsolute(path))] = true
	}
	usage := measureDiskUsage(toAbsolute(parsed.positional(0)), exclude)
	if jsonMode {
		emit(usage)
		return 0, nil
	}
	approx := ""
	if usage.Partial {
		approx = "~"
	}
	out(fmt.Sprintf("%s%d bytes on disk, %s%d reclaimable", approx, usage.Bytes, approx, usage.ReclaimableBytes))
	return 0, nil
}
