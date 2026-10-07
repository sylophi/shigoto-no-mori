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
// entry, so nothing is wiped and the worktree stays registered, and it
// reads as the guard's refusal.
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
	if err == nil || !strings.Contains(err.Error(), "uncommitted change") {
		t.Fatalf("execRemove err = %v, want the uncommitted-changes refusal", err)
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

// `status.showUntrackedFiles no` hides untracked files from plain
// status, but rm, land and adopt delete the folder with them inside,
// so their guard must still see them. The display probe keeps
// honoring the setting.
func TestRemovalGuardsSeeUntrackedFilesTheConfigHides(t *testing.T) {
	proj := autoPullSandbox(t)
	runGitT(t, proj.Path, "config", "status.showUntrackedFiles", "no")
	ctx := resolveContext(proj.Path, []project{proj})
	refused := func(what string, err error) {
		t.Helper()
		if err == nil || !strings.Contains(err.Error(), "uncommitted change") {
			t.Errorf("%s err = %v, want the uncommitted-changes refusal", what, err)
		}
	}

	wt := createViaCmd(t, proj, "otter")
	note := filepath.Join(wt.Path, "notes.txt")
	writeFileT(t, note, "only copy\n")
	if changes, err := getWorkingTreeChanges(wt.Path); err != nil || changes.count != 0 {
		t.Fatalf("display probe = %d, %v, want the setting honored", changes.count, err)
	}
	// The fixture has no remote, and a land past its guard asks gh next.
	bin := t.TempDir()
	writeFileT(t, filepath.Join(bin, "gh"), "#!/bin/sh\necho \"land got past its guard to gh $*\" >&2\nexit 1\n")
	if err := os.Chmod(filepath.Join(bin, "gh"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	_, err := cmdLand(ctx, []string{"otter"})
	refused("land", err)
	_, err = execRemove(proj, wt, removeOptions{})
	refused("rm", err)
	if _, err := os.Stat(note); err != nil {
		t.Errorf("the untracked file is gone: %v", err)
	}

	ext, err := moveWorktree(proj, createViaCmd(t, proj, "seal"), filepath.Join(t.TempDir(), "outside"))
	if err != nil {
		t.Fatal(err)
	}
	extNote := filepath.Join(ext.Path, "notes.txt")
	writeFileT(t, extNote, "only copy\n")
	_, err = cmdAdopt(ctx, []string{ext.Path})
	refused("adopt", err)
	if _, err := os.Stat(extNote); err != nil {
		t.Fatalf("adopt destroyed the untracked file: %v", err)
	}
}

// Land checks before its merge and hands the removal a preflighted
// worktree, so files written after that (here by the teardown) are
// left to git's own check at the delete, which must see untracked ones
// under `status.showUntrackedFiles no` too.
func TestRemovalChecksAgainAfterTheTeardown(t *testing.T) {
	proj := autoPullSandbox(t)
	runGitT(t, proj.Path, "config", "status.showUntrackedFiles", "no")
	if code, err := runConfigSet(projectConfigScope(proj), "scripts.teardown", "echo late > late.txt"); code != 0 || err != nil {
		t.Fatalf("set scripts.teardown: %d, %v", code, err)
	}
	wt := createViaCmd(t, proj, "otter")

	_, err := execRemove(proj, wt, removeOptions{preflighted: true})
	if err == nil || !strings.Contains(err.Error(), "while its cleanup scripts ran") || !strings.Contains(err.Error(), "--force --skip-cleanup") {
		t.Fatalf("execRemove err = %v, want the refusal that skips the scripts next time", err)
	}
	if got := readFileT(t, filepath.Join(wt.Path, "late.txt")); got != "late\n" {
		t.Fatalf("late.txt = %q", got)
	}
	if _, err := execRemove(proj, wt, removeOptions{preflighted: true, force: true, skipCleanup: true}); err != nil {
		t.Fatalf("forced: %v", err)
	}
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Errorf("forced removal left the checkout: %v", err)
	}
}
