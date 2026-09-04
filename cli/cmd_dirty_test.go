package main

// Tests for the dirty-state capture/apply primitive (cmd_dirty.go).
// Every fixture is a real repo with a linked worktree (`git worktree
// add`), and the assertions go through git's own porcelain and
// plumbing (show-ref, ls-tree, status), never the implementation's
// internals, matching the house style.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// runGitT's output-returning sibling for assertions.
func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	stdout, err := runGit(dir, args...)
	if err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return stdout
}

// A project repo with tracked files plus one linked worktree on its
// own branch: a.txt and gone.txt committed, ignored.txt gitignored.
// The parent is symlink-resolved so worktreeIDFromPath over our path
// matches the id derived from git's (resolved) porcelain output.
func seedDirtyFixture(t *testing.T) (projPath, wtPath, wtID string) {
	t.Helper()
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	projPath = seedRepo(t, parent, "proj")
	writeFileT(t, filepath.Join(projPath, "a.txt"), "alpha\n")
	writeFileT(t, filepath.Join(projPath, "gone.txt"), "bye\n")
	writeFileT(t, filepath.Join(projPath, ".gitignore"), "ignored.txt\n")
	runGitT(t, projPath, "add", "-A")
	runGitT(t, projPath, "commit", "-qm", "files")
	wtPath = filepath.Join(parent, "wt")
	runGitT(t, projPath, "worktree", "add", "-q", "-b", "work", wtPath)
	return projPath, wtPath, worktreeIDFromPath(wtPath)
}

// The worktree's status as path -> "XY" columns, for asserting both
// what changed and whether it sits staged or unstaged.
func statusMap(t *testing.T, wtPath string) map[string]string {
	t.Helper()
	entries, err := statusEntries(wtPath)
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]string{}
	for _, e := range entries {
		m[e.path] = string([]byte{e.index, e.worktree})
	}
	return m
}

func mustCapture(t *testing.T, projPath, wtPath, wtID string) dirtyCaptureResult {
	t.Helper()
	res, err := captureDirtyState(projPath, wtPath, wtID)
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if !res.captured {
		t.Fatal("capture reported clean on a dirty worktree")
	}
	return res
}

// Modified + untracked land in the capture tree, ignored files do not, and
// the commit's parent is the worktree's HEAD.
func TestDirtyCaptureContents(t *testing.T) {
	projPath, wtPath, wtID := seedDirtyFixture(t)
	writeFileT(t, filepath.Join(wtPath, "a.txt"), "changed\n")
	writeFileT(t, filepath.Join(wtPath, "new.txt"), "fresh\n")
	writeFileT(t, filepath.Join(wtPath, "ignored.txt"), "secret\n")
	head := strings.TrimSpace(gitOut(t, wtPath, "rev-parse", "HEAD"))

	res := mustCapture(t, projPath, wtPath, wtID)
	if res.parent != head {
		t.Errorf("parent = %s, want HEAD %s", res.parent, head)
	}
	if res.changedFiles != 2 {
		t.Errorf("changedFiles = %d, want 2", res.changedFiles)
	}
	refTip := strings.TrimSpace(gitOut(t, projPath, "rev-parse", dirtyRef(wtID)))
	if refTip != res.commit {
		t.Errorf("ref points at %s, want %s", refTip, res.commit)
	}
	tree := gitOut(t, projPath, "ls-tree", "-r", "--name-only", res.commit)
	for _, want := range []string{"a.txt", "new.txt", "gone.txt", ".gitignore"} {
		if !strings.Contains(tree, want) {
			t.Errorf("capture tree missing %s:\n%s", want, tree)
		}
	}
	if strings.Contains(tree, "ignored.txt") {
		t.Errorf("capture tree includes the gitignored file:\n%s", tree)
	}
	if got := gitOut(t, projPath, "show", res.commit+":a.txt"); got != "changed\n" {
		t.Errorf("captured a.txt = %q, want %q", got, "changed\n")
	}
}

// Capture works on a temporary index: the real index (staged hunks
// included) and the porcelain status must come through untouched.
func TestDirtyCaptureLeavesRealIndexUntouched(t *testing.T) {
	projPath, wtPath, wtID := seedDirtyFixture(t)
	writeFileT(t, filepath.Join(wtPath, "a.txt"), "staged\n")
	runGitT(t, wtPath, "add", "a.txt")
	writeFileT(t, filepath.Join(wtPath, "gone.txt"), "unstaged\n")
	writeFileT(t, filepath.Join(wtPath, "new.txt"), "fresh\n")
	before := gitOut(t, wtPath, "status", "--porcelain=v1", "-z")
	stagedBefore := gitOut(t, wtPath, "diff", "--cached", "--name-only")

	mustCapture(t, projPath, wtPath, wtID)

	if after := gitOut(t, wtPath, "status", "--porcelain=v1", "-z"); after != before {
		t.Errorf("status changed across capture:\nbefore %q\nafter  %q", before, after)
	}
	if stagedAfter := gitOut(t, wtPath, "diff", "--cached", "--name-only"); stagedAfter != stagedBefore {
		t.Errorf("staged set changed across capture:\nbefore %q\nafter  %q", stagedBefore, stagedAfter)
	}
}

// A clean worktree captures nothing, and a stale ref from an earlier
// capture is consumed rather than left to describe state that's gone.
func TestDirtyCaptureCleanRemovesStaleRef(t *testing.T) {
	projPath, wtPath, wtID := seedDirtyFixture(t)
	writeFileT(t, filepath.Join(wtPath, "a.txt"), "changed\n")
	mustCapture(t, projPath, wtPath, wtID)
	runGitT(t, wtPath, "checkout", "--", "a.txt")

	res, err := captureDirtyState(projPath, wtPath, wtID)
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if res.captured {
		t.Error("capture reported dirty on a clean worktree")
	}
	if refExists(projPath, dirtyRef(wtID)) {
		t.Error("stale capture ref survived a clean capture")
	}
}

// Re-capturing overwrites in place: one ref per worktree, no history.
func TestDirtyCaptureOverwritesIdempotently(t *testing.T) {
	projPath, wtPath, wtID := seedDirtyFixture(t)
	writeFileT(t, filepath.Join(wtPath, "a.txt"), "first\n")
	first := mustCapture(t, projPath, wtPath, wtID)
	writeFileT(t, filepath.Join(wtPath, "a.txt"), "second\n")
	second := mustCapture(t, projPath, wtPath, wtID)

	if first.commit == second.commit {
		t.Error("distinct states captured to the same commit")
	}
	refs := strings.Fields(gitOut(t, projPath, "for-each-ref", "--format=%(objectname)", "refs/shigomori/dirty"))
	if len(refs) != 1 || refs[0] != second.commit {
		t.Errorf("refs/shigomori/dirty = %v, want exactly [%s]", refs, second.commit)
	}
}

// The full round trip on the states that are easy to lose: a staged
// modification, a deletion, an untracked file, and an ignored file.
// After apply the state is back (unstaged, deletion included, the
// ignored file absent) and the consumed ref is gone.
func TestDirtyRoundTrip(t *testing.T) {
	projPath, wtPath, wtID := seedDirtyFixture(t)
	writeFileT(t, filepath.Join(wtPath, "a.txt"), "changed\n")
	runGitT(t, wtPath, "add", "a.txt") // staged, to prove flattening
	if err := os.Remove(filepath.Join(wtPath, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	writeFileT(t, filepath.Join(wtPath, "new.txt"), "fresh\n")
	writeFileT(t, filepath.Join(wtPath, "ignored.txt"), "secret\n")
	head := strings.TrimSpace(gitOut(t, wtPath, "rev-parse", "HEAD"))

	capture := mustCapture(t, projPath, wtPath, wtID)

	// Reset to a clean target that never had the untracked/ignored
	// files, the receiving device in the sync flow.
	runGitT(t, wtPath, "reset", "--hard", "-q")
	for _, name := range []string{"new.txt", "ignored.txt"} {
		if err := os.Remove(filepath.Join(wtPath, name)); err != nil {
			t.Fatal(err)
		}
	}

	res, err := applyDirtyState(projPath, wtPath, wtID, false)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if res.commit != capture.commit {
		t.Errorf("applied %s, want %s", res.commit, capture.commit)
	}
	if res.changedFiles != 3 {
		t.Errorf("changedFiles = %d, want 3", res.changedFiles)
	}
	if data, err := os.ReadFile(filepath.Join(wtPath, "a.txt")); err != nil || string(data) != "changed\n" {
		t.Errorf("a.txt = %q, %v; want %q", data, err, "changed\n")
	}
	if data, err := os.ReadFile(filepath.Join(wtPath, "new.txt")); err != nil || string(data) != "fresh\n" {
		t.Errorf("new.txt = %q, %v; want %q", data, err, "fresh\n")
	}
	if _, err := os.Stat(filepath.Join(wtPath, "gone.txt")); !os.IsNotExist(err) {
		t.Error("deleted file came back after apply")
	}
	if _, err := os.Stat(filepath.Join(wtPath, "ignored.txt")); !os.IsNotExist(err) {
		t.Error("ignored file materialized on the target")
	}
	// Same HEAD, everything unstaged: the staged/unstaged split is
	// deliberately flattened.
	if got := strings.TrimSpace(gitOut(t, wtPath, "rev-parse", "HEAD")); got != head {
		t.Errorf("HEAD moved across apply: %s -> %s", head, got)
	}
	want := map[string]string{"a.txt": " M", "gone.txt": " D", "new.txt": "??"}
	got := statusMap(t, wtPath)
	for path, columns := range want {
		if got[path] != columns {
			t.Errorf("status[%s] = %q, want %q", path, got[path], columns)
		}
	}
	if staged := strings.TrimSpace(gitOut(t, wtPath, "diff", "--cached", "--name-only")); staged != "" {
		t.Errorf("apply left staged entries: %q", staged)
	}
	if refExists(projPath, dirtyRef(wtID)) {
		t.Error("apply left the consumed ref behind")
	}
}

// Apply fails closed on a dirty target (untracked counts as dirty)
// and --force is the escape.
func TestDirtyApplyRefusesDirtyTarget(t *testing.T) {
	projPath, wtPath, wtID := seedDirtyFixture(t)
	writeFileT(t, filepath.Join(wtPath, "a.txt"), "changed\n")
	mustCapture(t, projPath, wtPath, wtID)
	runGitT(t, wtPath, "reset", "--hard", "-q")
	writeFileT(t, filepath.Join(wtPath, "stray.txt"), "untracked\n")

	if _, err := applyDirtyState(projPath, wtPath, wtID, false); err == nil {
		t.Fatal("apply succeeded on a dirty target")
	} else if !strings.Contains(err.Error(), "uncommitted change(s)") {
		t.Fatalf("unexpected refusal: %v", err)
	}
	if !refExists(projPath, dirtyRef(wtID)) {
		t.Fatal("refused apply consumed the ref")
	}
	if _, err := applyDirtyState(projPath, wtPath, wtID, true); err != nil {
		t.Fatalf("forced apply: %v", err)
	}
	got := statusMap(t, wtPath)
	if got["a.txt"] != " M" || got["stray.txt"] != "??" {
		t.Errorf("status after forced apply = %v", got)
	}
}

// git's read-tree collision check treats ignored files as expendable,
// so apply probes capture-added paths itself: a target that is clean
// by status but holds an ignored file where the capture adds one
// refuses with the coded kind, keeps the file, and keeps the ref.
func TestDirtyApplyRefusesIgnoredFileClobber(t *testing.T) {
	projPath, wtPath, wtID := seedDirtyFixture(t)
	writeFileT(t, filepath.Join(wtPath, "cfg.local"), "from source\n")
	mustCapture(t, projPath, wtPath, wtID)
	runGitT(t, wtPath, "reset", "--hard", "-q")
	if err := os.Remove(filepath.Join(wtPath, "cfg.local")); err != nil {
		t.Fatal(err)
	}

	// The receiving device ignores the path (per-device ignore state
	// never syncs) and holds real data there. Status reads clean.
	writeFileT(t, filepath.Join(projPath, ".git", "info", "exclude"), "cfg.local\n")
	writeFileT(t, filepath.Join(wtPath, "cfg.local"), "local secrets\n")

	_, err := applyDirtyState(projPath, wtPath, wtID, false)
	if err == nil {
		t.Fatal("apply overwrote an ignored file")
	}
	if kind := errorKindOf(err); kind != "capture-overwrite" {
		t.Errorf("error kind = %q, want capture-overwrite", kind)
	}
	if !strings.Contains(err.Error(), "cfg.local") {
		t.Errorf("refusal doesn't name the path: %v", err)
	}
	if data, readErr := os.ReadFile(filepath.Join(wtPath, "cfg.local")); readErr != nil || string(data) != "local secrets\n" {
		t.Errorf("cfg.local = %q, %v; want the local content intact", data, readErr)
	}
	if !refExists(projPath, dirtyRef(wtID)) {
		t.Error("refused apply consumed the ref")
	}
}

// --force skips only the cleanliness probe: an untracked file at a
// capture-added path still refuses, because force must never make
// apply destructive.
func TestDirtyApplyForceKeepsAddCollisionGuard(t *testing.T) {
	projPath, wtPath, wtID := seedDirtyFixture(t)
	writeFileT(t, filepath.Join(wtPath, "new.txt"), "from source\n")
	mustCapture(t, projPath, wtPath, wtID)
	writeFileT(t, filepath.Join(wtPath, "new.txt"), "local work\n")

	_, err := applyDirtyState(projPath, wtPath, wtID, true)
	if err == nil {
		t.Fatal("forced apply overwrote an untracked file")
	}
	if kind := errorKindOf(err); kind != "capture-overwrite" {
		t.Errorf("error kind = %q, want capture-overwrite", kind)
	}
	if data, readErr := os.ReadFile(filepath.Join(wtPath, "new.txt")); readErr != nil || string(data) != "local work\n" {
		t.Errorf("new.txt = %q, %v; want the local content intact", data, readErr)
	}
	if !refExists(projPath, dirtyRef(wtID)) {
		t.Error("refused apply consumed the ref")
	}
}

// --force can't override git either: a modified tracked file the
// capture touches makes read-tree refuse. The refusal carries the
// friendly overlap prose, the worktree and index survive intact, and
// the ref is kept.
func TestDirtyApplyForceOverlapRefusedByGit(t *testing.T) {
	projPath, wtPath, wtID := seedDirtyFixture(t)
	writeFileT(t, filepath.Join(wtPath, "a.txt"), "changed\n")
	mustCapture(t, projPath, wtPath, wtID)
	writeFileT(t, filepath.Join(wtPath, "a.txt"), "local edit\n")

	_, err := applyDirtyState(projPath, wtPath, wtID, true)
	if err == nil {
		t.Fatal("forced apply overwrote a modified tracked file")
	}
	if !strings.Contains(err.Error(), "overlap the capture") {
		t.Errorf("refusal lacks the overlap prose: %v", err)
	}
	if data, readErr := os.ReadFile(filepath.Join(wtPath, "a.txt")); readErr != nil || string(data) != "local edit\n" {
		t.Errorf("a.txt = %q, %v; want the local content intact", data, readErr)
	}
	if got := statusMap(t, wtPath); got["a.txt"] != " M" {
		t.Errorf("status[a.txt] = %q after refused apply, want %q", got["a.txt"], " M")
	}
	if staged := strings.TrimSpace(gitOut(t, wtPath, "diff", "--cached", "--name-only")); staged != "" {
		t.Errorf("refused apply left staged entries: %q", staged)
	}
	if !refExists(projPath, dirtyRef(wtID)) {
		t.Error("refused apply consumed the ref")
	}
}

// A HEAD that isn't the capture's parent is a skipped sync step, not a
// forceable inconvenience: coded refusal, ref kept.
func TestDirtyApplyRefusesBaseMismatch(t *testing.T) {
	projPath, wtPath, wtID := seedDirtyFixture(t)
	writeFileT(t, filepath.Join(wtPath, "a.txt"), "changed\n")
	mustCapture(t, projPath, wtPath, wtID)
	runGitT(t, wtPath, "reset", "--hard", "-q")
	runGitT(t, wtPath, "commit", "-q", "--allow-empty", "-m", "moved on")

	_, err := applyDirtyState(projPath, wtPath, wtID, true)
	if err == nil {
		t.Fatal("apply succeeded across a base mismatch")
	}
	if kind := errorKindOf(err); kind != "capture-base-mismatch" {
		t.Errorf("error kind = %q, want capture-base-mismatch", kind)
	}
	if !refExists(projPath, dirtyRef(wtID)) {
		t.Error("refused apply consumed the ref")
	}
}

func TestDirtyApplyWithoutCapture(t *testing.T) {
	projPath, wtPath, wtID := seedDirtyFixture(t)
	_, err := applyDirtyState(projPath, wtPath, wtID, false)
	if err == nil {
		t.Fatal("apply succeeded with no capture ref")
	}
	if kind := errorKindOf(err); kind != "no-capture" {
		t.Errorf("error kind = %q, want no-capture", kind)
	}
}

// rm's cleanup consumes the capture ref along with the worktree's
// other state.
func TestRmDeletesDirtyCaptureRef(t *testing.T) {
	sandboxDataDir(t)
	projPath, wtPath, wtID := seedDirtyFixture(t)
	writeFileT(t, filepath.Join(wtPath, "a.txt"), "changed\n")
	mustCapture(t, projPath, wtPath, wtID)
	runGitT(t, wtPath, "checkout", "--", "a.txt")

	proj := project{ID: "RMDIRTY", Name: "proj", Path: projPath}
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		t.Fatal(err)
	}
	var target worktreeIdentity
	for _, id := range identities {
		if !id.IsPrimary {
			target = id
		}
	}
	if target.ID != wtID {
		t.Fatalf("worktree id mismatch: identity %s vs path-derived %s", target.ID, wtID)
	}
	if _, err := execRemove(proj, target, removeOptions{}); err != nil {
		t.Fatalf("execRemove: %v", err)
	}
	if refExists(projPath, dirtyRef(wtID)) {
		t.Error("rm left the dirty-state capture ref behind")
	}
}
