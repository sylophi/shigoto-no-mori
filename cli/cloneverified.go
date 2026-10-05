package main

// The clone checkout's record of source files it has proven: a file
// hashed against its blob holds that blob's bytes for as long as its
// stat stays what it was, whatever happens to attributes after. Kept
// so a file that has to be read back (git last checked it before the
// attributes changed, and never will again while it's untouched) is
// read once, not on every clone. cloneVerified/<source hash>.json
// under the data dir, by the source's worktree id (forgetWorktree drops
// it): path -> "<oid> <stat>" as the source's index entry had it.
// Losing it only costs reading those files again.

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type cloneVerified struct {
	Source string            `json:"source"`
	Files  map[string]string `json:"files"`
}

func cloneVerifiedPath(source string) string {
	return cloneVerifiedPathForID(worktreeIDFromPath(source))
}

func cloneVerifiedPathForID(worktreeID string) string {
	return filepath.Join(dataDir(), "cloneVerified", worktreeID+".json")
}

// The record for an index entry: its blob and the stat that pins the
// file to it.
func verifiedRecord(oid string, st indexStat) string {
	return fmt.Sprintf("%s %d.%d %d.%d %d %d %d", oid,
		st.ctimeSec, st.ctimeNsec, st.mtimeSec, st.mtimeNsec, st.dev, st.ino, st.size)
}

// The source's records, empty when there are none or they can't be
// read, and the file's mtime as read (zero without one).
func readCloneVerified(source string) (map[string]string, time.Time) {
	path := cloneVerifiedPath(source)
	info, err := os.Stat(path)
	v, ok := readJSONFile[cloneVerified](path)
	if err != nil || !ok || v.Source != source || v.Files == nil {
		return map[string]string{}, time.Time{}
	}
	return v.Files, info.ModTime()
}

// Adds the newly proven records to the source's file, dropping any
// whose path no longer has that blob and stat in the source's index
// (`current`), under the data dir's file lock. `read` is what this run
// read (the file as of `readAt`), reused unless another run wrote the
// file since.
func updateCloneVerified(source string, read map[string]string, readAt time.Time, added map[string]string, current func(path, record string) bool) error {
	path := cloneVerifiedPath(source)
	return withFileLock(path, func() error {
		files := read
		if info, err := os.Stat(path); err == nil && !info.ModTime().Equal(readAt) {
			files, _ = readCloneVerified(source)
		}
		for p, record := range files {
			if !current(p, record) {
				delete(files, p)
			}
		}
		for p, record := range added {
			files[p] = record
		}
		return atomicWriteJSON(path, cloneVerified{Source: source, Files: files})
	})
}
