package main

// sm worktrees move [<name>] <new-path>: relocate a worktree's
// checkout. `git worktree move` does the disk and git's own metadata,
// and a move to another volume, which git can't make, is copied across
// instead (moveAcrossVolumes).
// A worktree's id is derived from its path, so the move changes it,
// and everything shigomori keys by the old id is carried to the new
// one: the registry marks (shelf, auto-pull), the per-worktree data
// file, and a pending dirty-state capture ref. The app's layout change
// (Configure > Worktree location) moves its managed worktrees through
// here.
//
// What stays with the caller: the app's own in-process state for the
// worktree (running scripts, mirror sessions, the delete-inflight
// tombstone) lives in the app, so it wraps this call in its tombstone
// the way it wraps `sm rm`. From a terminal, stop what the app runs
// there first, like rm.

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func cmdMove(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, worktreeTargetSpec())
	if err != nil {
		return exitCodeOf(err), err
	}
	// The destination is always the last positional. The worktree ref
	// before it is optional: the cwd's worktree, or --worktree-id.
	n := len(parsed.positionals)
	maxRefs := 1
	if parsed.strings["worktree-id"] != "" {
		maxRefs = 0
	}
	if n == 0 || n-1 > maxRefs {
		return 2, usageErrf("Usage: %s worktrees move [<name>] <new-path>", binaryName)
	}
	dest := filepath.Clean(toAbsolute(parsed.positionals[n-1]))
	parsed.positionals = parsed.positionals[:n-1]
	target, err := resolveWorktreeArgs(ctx, parsed, false)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree
	if id.IsPrimary {
		return 1, errf("The primary checkout can't be moved")
	}

	wasInside := cwdInside(id.Path)
	row, err := moveWorktree(proj, id, dest)
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emit(map[string]any{"ok": true, "worktree": row, "previousId": id.ID})
		return 0, nil
	}
	out(row.Path)
	if wasInside && row.Path != id.Path {
		note(dimErr("note: your shell is inside the old location. Run `cd " + row.Path + "`"))
	}
	return 0, nil
}

// Moves the checkout and re-keys its state, answering with the moved
// worktree's row. A destination equal to the current path is a no-op
// that still answers with the row.
func moveWorktree(proj project, id worktreeIdentity, dest string) (worktreeJSON, error) {
	if dest != id.Path {
		// git would move the checkout INTO an existing directory, which
		// lands it at a path (and id) other than the one asked for.
		if _, err := os.Lstat(dest); err == nil {
			return worktreeJSON{}, errf("Destination already exists: %s", dest)
		} else if !errors.Is(err, os.ErrNotExist) {
			return worktreeJSON{}, err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return worktreeJSON{}, err
		}
		// The cross-volume path has already re-read git's list, so only
		// git's own move leaves it stale.
		if err := gitWorktreeMoveFn(proj.Path, id.Path, dest); err == nil {
			invalidateWorktreeIdentities(proj.ID)
		} else if !isCrossDeviceError(err) {
			return worktreeJSON{}, err
		} else if err := moveAcrossVolumes(proj, id.Path, dest); err != nil {
			return worktreeJSON{}, err
		}
		// Sweep the old parent when it is a directory shigomori owns
		// (the custom layout's is the user's, and stays).
		pruneEmptyManagedParents(id.Path, proj.Path)
	}
	moved, err := findMovedIdentity(proj, dest)
	if err != nil {
		return worktreeJSON{}, err
	}
	if moved.ID != id.ID {
		rekeyWorktree(proj, id.ID, moved.ID)
	}
	return buildWorktree(proj, moved, loadBuildContext(proj)), nil
}

// Test seam: a second volume is nothing a test can count on, so tests
// stub git's refusal to cross one.
var gitWorktreeMoveFn = func(projectPath, from, dest string) error {
	_, err := runGit(projectPath, "worktree", "move", "--", from, dest)
	return err
}

// Whether a failed `git worktree move` is rename(2) refusing to leave
// its volume (EXDEV, in the C locale every git spawn here runs under).
// Git checks everything else first (the worktree is unlocked, has no
// submodules, the destination is free), so this error means a move git
// was otherwise willing to make.
func isCrossDeviceError(err error) bool {
	var gitErr *gitError
	return errors.As(err, &gitErr) && strings.Contains(strings.ToLower(gitErr.msg), "cross-device link")
}

// The move git can't make: the checkout is copied to the other volume,
// git is pointed at the copy (`git worktree repair`, its own answer to
// a checkout moved by hand), and the original goes only once git lists
// the worktree at its new path. A failure before that leaves the
// original as it was and takes the copy back out.
func moveAcrossVolumes(proj project, from, dest string) error {
	undo := func() {
		_ = wipeDir(dest)
		_, _ = runGit(proj.Path, "worktree", "repair", "--", from)
		invalidateWorktreeIdentities(proj.ID)
	}
	if err := copyCheckout(from, dest); err != nil {
		undo()
		return errf("Couldn't copy the worktree to %s: %v", dest, err)
	}
	if _, err := runGit(proj.Path, "worktree", "repair", "--", dest); err != nil {
		undo()
		return err
	}
	invalidateWorktreeIdentities(proj.ID)
	if _, err := findMovedIdentity(proj, dest); err != nil {
		undo()
		return err
	}
	// The move is done as far as git goes. A leftover original is a
	// stray folder, not a reason to report the move as failed.
	if err := wipeDir(from); err != nil {
		note("warning: the worktree moved, but its old folder couldn't be deleted: " + err.Error())
	}
	return nil
}

// cp -p keeps the times and modes a move should keep. A filesystem that
// can't hold some of them fails the whole cp, so the plain copy is the
// second try. No clone attempt: clonefile can't cross volumes.
func copyCheckout(src, dst string) error {
	err := cpTree(src, dst, "-p")
	if err == nil {
		return nil
	}
	vlog("[move] cp -p: %v", err)
	if err := wipeDir(dst); err != nil {
		return err
	}
	return cpTree(src, dst)
}

// The identity git now lists at dest. Its path is git's spelling,
// which the id derives from, so the re-key follows git rather than
// the spelling the caller passed (a symlinked parent, say).
func findMovedIdentity(proj project, dest string) (worktreeIdentity, error) {
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		return worktreeIdentity{}, err
	}
	resolved, _ := filepath.EvalSymlinks(dest)
	for _, candidate := range identities {
		if candidate.Path == dest || (resolved != "" && candidate.Path == resolved) {
			return candidate, nil
		}
	}
	return worktreeIdentity{}, errf("git doesn't list a worktree at %s after the move", dest)
}

// Carries everything keyed by a worktree id from one id to another.
// Best-effort per piece, like dropWorktreeMarks: the checkout has
// already moved, and failing the command over a leftover mark would
// report a move that did happen as one that didn't.
func rekeyWorktree(proj project, from, to string) {
	moveWorktreeMarks(from, to)
	oldData, newData := worktreeDataPath(proj.ID, from), worktreeDataPath(proj.ID, to)
	if err := os.Rename(oldData, newData); err != nil && !errors.Is(err, os.ErrNotExist) {
		vlog("[move] worktree data: %v", err)
	}
	// A pending capture (refs/shigomori/dirty/<id>) belongs to the
	// worktree, not its old path.
	if commit, err := runGit(proj.Path, "rev-parse", "--verify", "--quiet", dirtyRef(from)); err == nil {
		if _, err := runGit(proj.Path, "update-ref", "--end-of-options", dirtyRef(to), strings.TrimSpace(commit)); err == nil {
			dropDirtyCapture(proj.Path, from)
		} else {
			vlog("[move] dirty capture: %v", err)
		}
	}
}

// sm worktrees rekey --project-id P --from-id A --to-path X: app
// plumbing for the data-folder move, which relocates managed worktree
// checkouts itself. It runs BEFORE the directories move, so nothing
// here asks git about X or requires it to exist: it only carries what
// is keyed by A (rekeyWorktree) over to the id X will have, and answers
// with that id. Best-effort like the re-key after `move`.
func cmdRekey(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"project-id": {}, "from-id": {}, "to-path": {}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	pid, from, to := parsed.strings["project-id"], parsed.strings["from-id"], parsed.strings["to-path"]
	if pid == "" || from == "" || to == "" || len(parsed.positionals) > 0 {
		return 2, usageErrf("Usage: %s worktrees rekey --project-id <id> --from-id <id> --to-path <path>", binaryName)
	}
	if !filepath.IsAbs(to) {
		return 2, usageErrf("--to-path must be absolute: %s", to)
	}
	proj, err := resolveProjectByID(ctx, pid)
	if err != nil {
		return exitCodeOf(err), err
	}
	newID := worktreeIDFromPath(filepath.Clean(to))
	if newID != from {
		rekeyWorktree(proj, from, newID)
	}
	emitOrOut(map[string]any{"ok": true, "id": newID}, newID)
	return 0, nil
}
