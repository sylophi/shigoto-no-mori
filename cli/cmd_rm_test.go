package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func stubWorktreeRemove(t *testing.T, fn func(projectPath, worktreePath string, force bool) error) {
	t.Helper()
	saved := gitWorktreeRemoveFn
	gitWorktreeRemoveFn = fn
	t.Cleanup(func() { gitWorktreeRemoveFn = saved })
}

// Git's end state after an abandoned sweep: admin entry gone, residue
// left in the checkout, and the error git prints for it.
func abandonedSweep(t *testing.T) func(projectPath, worktreePath string, force bool) error {
	return func(_, worktreePath string, _ bool) error {
		if err := os.RemoveAll(worktreeAdminDir(worktreePath)); err != nil {
			t.Fatal(err)
		}
		writeFileT(t, filepath.Join(worktreePath, "cache", "late.log"), "late\n")
		return errors.New("git worktree remove " + worktreePath +
			": error: failed to delete '" + worktreePath + "': Directory not empty")
	}
}

func gitListsWorktreeT(t *testing.T, projPath, wtPath string) bool {
	t.Helper()
	for _, entry := range parsePorcelain(gitOut(t, projPath, "worktree", "list", "--porcelain")) {
		if entry.path == wtPath {
			return true
		}
	}
	return false
}

// A plain (unforced) rm whose git sweep stops short (see
// removeWorktreeDir) still removes the worktree: the residue is wiped
// and git's list stays honest.
func TestRmFinishesSweepGitAbandoned(t *testing.T) {
	sandboxDataDir(t)
	projPath, wtPath, _ := seedDirtyFixture(t)
	proj := project{ID: "RMSWEEP", Name: "proj", Path: projPath}
	target := identityAt(t, proj, wtPath)
	stubWorktreeRemove(t, abandonedSweep(t))

	if _, err := execRemove(proj, target, removeOptions{}); err != nil {
		t.Fatalf("execRemove: %v", err)
	}
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Errorf("worktree directory still on disk (stat err %v)", err)
	}
	if gitListsWorktreeT(t, projPath, wtPath) {
		t.Error("git still lists the removed worktree")
	}
}

// A refusal before the sweep (git's own dirty check) keeps the admin
// entry, so nothing is wiped and the worktree stays registered.
func TestRmKeepsCheckoutWhenGitRefuses(t *testing.T) {
	sandboxDataDir(t)
	projPath, wtPath, _ := seedDirtyFixture(t)
	proj := project{ID: "RMREFUSE", Name: "proj", Path: projPath}
	target := identityAt(t, proj, wtPath)
	stubWorktreeRemove(t, func(_, worktreePath string, _ bool) error {
		return errors.New("git worktree remove " + worktreePath +
			": fatal: '" + worktreePath + "' contains modified or untracked files, use --force to delete it")
	})

	_, err := execRemove(proj, target, removeOptions{})
	if err == nil || !strings.Contains(err.Error(), "use --force") {
		t.Fatalf("execRemove err = %v, want git's refusal", err)
	}
	if _, err := os.Stat(filepath.Join(wtPath, "a.txt")); err != nil {
		t.Errorf("checkout was touched: %v", err)
	}
	if !gitListsWorktreeT(t, projPath, wtPath) {
		t.Error("git no longer lists the kept worktree")
	}
}

// The wipe never reaches a directory git never registered: with no
// .git file naming an admin entry, git's error comes back and the
// directory stays.
func TestRemoveWorktreeDirLeavesUnregisteredDir(t *testing.T) {
	projPath, _, _ := seedDirtyFixture(t)
	plain := filepath.Join(filepath.Dir(projPath), "plain")
	writeFileT(t, filepath.Join(plain, "keep.txt"), "keep\n")
	stubWorktreeRemove(t, func(_, worktreePath string, _ bool) error {
		return errors.New("git worktree remove " + worktreePath + ": fatal: '" + worktreePath + "' is not a working tree")
	})

	err := removeWorktreeDir(projPath, plain, false)
	if err == nil || !strings.Contains(err.Error(), "not a working tree") {
		t.Fatalf("err = %v, want git's error unchanged", err)
	}
	if _, err := os.Stat(filepath.Join(plain, "keep.txt")); err != nil {
		t.Errorf("unregistered directory was touched: %v", err)
	}
}

// A wipe that fails after git dropped the entry reports the orphan and
// still runs the bookkeeping: the marks go, since no worktree remains
// to carry them.
func TestRmReportsOrphanAndDropsMarks(t *testing.T) {
	sandboxDataDir(t)
	projPath, wtPath, _ := seedDirtyFixture(t)
	proj := project{ID: "RMORPHAN", Name: "proj", Path: projPath}
	target := identityAt(t, proj, wtPath)
	if err := setShelved(target.ID, true); err != nil {
		t.Fatal(err)
	}
	// A read-only directory defeats os.RemoveAll (EACCES, not the
	// ENOTEMPTY the retry waits on).
	locked := filepath.Join(wtPath, "cache", "locked")
	writeFileT(t, filepath.Join(locked, "f"), "x\n")
	if err := os.Chmod(locked, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })
	stubWorktreeRemove(t, abandonedSweep(t))

	// Forced: the locked directory is untracked, which the unforced
	// preflight would refuse before git ever ran.
	_, err := execRemove(proj, target, removeOptions{force: true})
	var orphaned *orphanedWorktreeError
	if !errors.As(err, &orphaned) {
		t.Fatalf("err = %v, want orphanedWorktreeError", err)
	}
	if !strings.Contains(err.Error(), "Directory not empty") {
		t.Errorf("git's error dropped from %q", err)
	}
	if _, err := os.Stat(locked); err != nil {
		t.Errorf("orphan should still be on disk: %v", err)
	}
	if readShelvedSet()[target.ID] {
		t.Error("shelved mark survived the removal")
	}
}
