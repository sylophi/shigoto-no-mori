package main

// sm worktrees move: the checkout moves, and everything keyed by its
// path-derived id follows it to the new id. Against real git in a temp
// SHIGOMORI_DATA_DIR.

import (
	"os"
	"path/filepath"
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
