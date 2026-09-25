package main

// sm worktrees move [<name>] <new-path>: relocate a worktree's
// checkout. `git worktree move` does the disk and git's own metadata.
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
		if _, err := runGit(proj.Path, "worktree", "move", "--", id.Path, dest); err != nil {
			return worktreeJSON{}, err
		}
		// Sweep the old parent when it is a directory shigomori owns
		// (the custom layout's is the user's, and stays).
		pruneEmptyManagedParents(id.Path, proj.Path)
		invalidateWorktreeIdentities(proj.ID)
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
