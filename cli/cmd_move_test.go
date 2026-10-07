package main

// sm worktrees move: the checkout moves, and everything keyed by its
// path-derived id follows it to the new id. Against real git in a temp
// SHIGOMORI_DATA_DIR.

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestMoveRekeysEverythingKeyedByID(t *testing.T) {
	proj := autoPullSandbox(t)
	wt := createViaCmd(t, proj, "fox")
	// One of each thing keyed by the id: both registry marks, the
	// per-worktree data file, a pending dirty capture.
	if err := setShelved(wt.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := setRegistryMark(autoPullKey, wt.ID, true); err != nil {
		t.Fatal(err)
	}
	writeFileT(t, worktreeDataPath(proj.ID, wt.ID), `{"notes":"keep me"}`)
	head := strings.TrimSpace(gitOut(t, wt.Path, "rev-parse", "HEAD"))
	runGitT(t, proj.Path, "update-ref", dirtyRef(wt.ID), head)

	dest := filepath.Join(filepath.Dir(proj.Path), "elsewhere", "fox")
	ctx := cliContext{projects: []project{proj}}
	docs := captureJSON(t, func() {
		if code, err := cmdMove(ctx, []string{"--project-id", proj.ID, "--worktree-id", wt.ID, dest}); code != 0 || err != nil {
			t.Fatalf("move: %d, %v", code, err)
		}
	})
	doc := decodeT[struct {
		OK         bool         `json:"ok"`
		Worktree   worktreeJSON `json:"worktree"`
		PreviousID string       `json:"previousId"`
	}](t, onlyDoc(t, docs))
	row := doc.Worktree
	newID := worktreeIDFromPath(dest)
	if !doc.OK || doc.PreviousID != wt.ID || row.ID != newID || row.Path != dest || row.Name != "fox" {
		t.Fatalf("move answered %+v, want the row at %s (id %s)", doc, dest, newID)
	}
	// Outside every managed base now, so external, and externals never
	// report the shelf. The mark itself still moved (checked below).
	if !row.IsExternal || row.Shelved || !row.AutoPull {
		t.Errorf("row external %v shelved %v autoPull %v, want true/false/true", row.IsExternal, row.Shelved, row.AutoPull)
	}
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Errorf("old checkout still there: %v", err)
	}
	for _, key := range []string{shelvedKey, autoPullKey} {
		marks := readRegistryMarkSet(key)
		if marks[wt.ID] || !marks[newID] {
			t.Errorf("%s: old %v new %v, want the mark moved", key, marks[wt.ID], marks[newID])
		}
	}
	if _, err := os.Stat(worktreeDataPath(proj.ID, wt.ID)); !os.IsNotExist(err) {
		t.Errorf("old data file still there: %v", err)
	}
	if data := readFileT(t, worktreeDataPath(proj.ID, newID)); !strings.Contains(data, "keep me") {
		t.Errorf("data file didn't follow: %q", data)
	}
	if got := strings.TrimSpace(gitOut(t, proj.Path, "rev-parse", dirtyRef(newID))); got != head {
		t.Errorf("dirty capture at new id = %q, want %s", got, head)
	}
	if _, err := runGit(proj.Path, "rev-parse", "--verify", "--quiet", dirtyRef(wt.ID)); err == nil {
		t.Error("dirty capture still under the old id")
	}

	// Moving it back into the managed base makes it managed again.
	back := wt.Path
	docs = captureJSON(t, func() {
		if code, err := cmdMove(ctx, []string{"--project-id", proj.ID, "--worktree-id", newID, back}); code != 0 || err != nil {
			t.Fatalf("move back: %d, %v", code, err)
		}
	})
	row = decodeT[struct {
		Worktree worktreeJSON `json:"worktree"`
	}](t, onlyDoc(t, docs)).Worktree
	if row.ID != wt.ID || row.IsExternal || !row.Shelved {
		t.Errorf("moved back: %+v, want the original id, managed, shelved", row)
	}
}

// A move out of the layout carries a pending capture to the external
// id, and adopting the checkout back carries it on to the managed one,
// where apply still finds it.
func TestAdoptRekeysAPendingCapture(t *testing.T) {
	proj := autoPullSandbox(t)
	wt := createViaCmd(t, proj, "otter")
	note := filepath.Join(wt.Path, "notes.txt")
	writeFileT(t, note, "captured\n")
	if res, err := captureDirtyState(proj.Path, wt.Path, wt.ID); err != nil || !res.captured {
		t.Fatalf("capture: %+v, %v", res, err)
	}
	if err := os.Remove(note); err != nil {
		t.Fatal(err)
	}
	moved, err := moveWorktree(proj, wt, filepath.Join(t.TempDir(), "outside"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := resolveContext(proj.Path, []project{proj})
	if code, err := cmdAdopt(ctx, []string{moved.Path}); code != 0 || err != nil {
		t.Fatalf("adopt: %d, %v", code, err)
	}
	adopted := identityAt(t, proj, wt.Path)
	if refExists(proj.Path, dirtyRef(moved.ID)) {
		t.Error("capture still under the external id")
	}
	if _, err := applyDirtyState(proj.Path, adopted.Path, adopted.ID, false); err != nil {
		t.Fatalf("apply after adopt: %v", err)
	}
	if got := readFileT(t, note); got != "captured\n" {
		t.Fatalf("applied %q", got)
	}
}

// What git answers when the destination is on another volume.
func stubCrossDeviceMove(t *testing.T) {
	t.Helper()
	saved := gitWorktreeMoveFn
	gitWorktreeMoveFn = func(_, from, dest string) error {
		return &gitError{
			args: []string{"worktree", "move", "--", from, dest},
			msg:  "fatal: failed to move '" + from + "' to '" + dest + "': Cross-device link",
		}
	}
	t.Cleanup(func() { gitWorktreeMoveFn = saved })
}

func TestMoveAcrossVolumesCopiesThenRepairs(t *testing.T) {
	proj := autoPullSandbox(t)
	wt := createViaCmd(t, proj, "fox")
	// Uncommitted work of every kind rides along: an edit, an untracked
	// file, a symlink, an executable.
	writeFileT(t, filepath.Join(wt.Path, "untracked.txt"), "not committed\n")
	writeFileT(t, filepath.Join(wt.Path, "run.sh"), "#!/bin/sh\n")
	if err := os.Chmod(filepath.Join(wt.Path, "run.sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("untracked.txt", filepath.Join(wt.Path, "link")); err != nil {
		t.Fatal(err)
	}
	if err := setRegistryMark(autoPullKey, wt.ID, true); err != nil {
		t.Fatal(err)
	}
	statusBefore := gitOut(t, wt.Path, "status", "--porcelain")
	stubCrossDeviceMove(t)

	dest := filepath.Join(filepath.Dir(proj.Path), "other-volume", "fox")
	ctx := cliContext{projects: []project{proj}}
	if code, err := cmdMove(ctx, []string{"--project-id", proj.ID, "--worktree-id", wt.ID, dest}); code != 0 || err != nil {
		t.Fatalf("move: %d, %v", code, err)
	}

	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Errorf("old checkout still there: %v", err)
	}
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		t.Fatal(err)
	}
	var listed []string
	for _, identity := range identities {
		listed = append(listed, identity.Path)
	}
	if want := []string{proj.Path, dest}; !slices.Equal(listed, want) {
		t.Errorf("git lists %v, want %v", listed, want)
	}
	// Git works from the copy, on the same branch with the same changes.
	if branch := strings.TrimSpace(gitOut(t, dest, "branch", "--show-current")); branch != "fox" {
		t.Errorf("branch at the new path = %q, want fox", branch)
	}
	if status := gitOut(t, dest, "status", "--porcelain"); status != statusBefore {
		t.Errorf("status after the move = %q, want %q", status, statusBefore)
	}
	if info, err := os.Stat(filepath.Join(dest, "run.sh")); err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Errorf("run.sh lost its executable bit: %v, %v", info, err)
	}
	if target, err := os.Readlink(filepath.Join(dest, "link")); err != nil || target != "untracked.txt" {
		t.Errorf("link = %q, %v, want a symlink to untracked.txt", target, err)
	}
	if marks := readRegistryMarkSet(autoPullKey); marks[wt.ID] || !marks[worktreeIDFromPath(dest)] {
		t.Errorf("auto-pull mark didn't follow the move: %v", marks)
	}
}

// A copy that can't be made leaves the worktree where it was, still
// git's, with nothing at the destination.
func TestMoveAcrossVolumesFailureKeepsTheOriginal(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes through the read-only folder that fails the copy")
	}
	proj := autoPullSandbox(t)
	wt := createViaCmd(t, proj, "fox")
	stubCrossDeviceMove(t)
	// A parent nothing can be written into fails the copy.
	parent := filepath.Join(filepath.Dir(proj.Path), "sealed")
	if err := os.MkdirAll(parent, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0o755) })

	dest := filepath.Join(parent, "fox")
	ctx := cliContext{projects: []project{proj}}
	if code, err := cmdMove(ctx, []string{"--project-id", proj.ID, "--worktree-id", wt.ID, dest}); code == 0 || err == nil {
		t.Fatalf("move into a sealed folder = %d, %v, want a failure", code, err)
	}
	if _, err := os.Lstat(dest); !os.IsNotExist(err) {
		t.Errorf("a failed move left something at the destination: %v", err)
	}
	if branch := strings.TrimSpace(gitOut(t, wt.Path, "branch", "--show-current")); branch != "fox" {
		t.Errorf("the original stopped working: branch = %q", branch)
	}
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		t.Fatal(err)
	}
	if len(identities) != 2 || identities[1].Path != wt.Path {
		t.Errorf("git lists %+v, want the worktree still at %s", identities, wt.Path)
	}
}

func TestMoveRefusals(t *testing.T) {
	proj := autoPullSandbox(t)
	wt := createViaCmd(t, proj, "fox")
	ctx := cliContext{projects: []project{proj}}
	primaryID := worktreeIDFromPath(proj.Path)

	if code, err := cmdMove(ctx, []string{"--worktree-id", primaryID, filepath.Join(t.TempDir(), "x")}); code != 1 || err == nil {
		t.Errorf("moving the primary = %d, %v, want a refusal", code, err)
	}
	occupied := t.TempDir()
	if code, err := cmdMove(ctx, []string{"--worktree-id", wt.ID, occupied}); code != 1 || err == nil ||
		!strings.Contains(err.Error(), "already exists") {
		t.Errorf("moving onto an existing path = %d, %v, want a refusal", code, err)
	}
	if code, _ := cmdMove(ctx, []string{"--worktree-id", wt.ID}); code != 2 {
		t.Errorf("no destination = exit %d, want 2", code)
	}
	if code, _ := cmdMove(ctx, []string{"--worktree-id", wt.ID, "fox", "/tmp/x"}); code != 2 {
		t.Errorf("a ref beside --worktree-id = exit %d, want 2", code)
	}

	// The current path is a no-op that still answers with the row.
	docs := captureJSON(t, func() {
		if code, err := cmdMove(ctx, []string{"--worktree-id", wt.ID, wt.Path}); code != 0 || err != nil {
			t.Fatalf("move in place: %d, %v", code, err)
		}
	})
	if row := decodeT[struct {
		Worktree worktreeJSON `json:"worktree"`
	}](t, onlyDoc(t, docs)).Worktree; row.ID != wt.ID {
		t.Errorf("in-place move answered %+v", row)
	}
}
