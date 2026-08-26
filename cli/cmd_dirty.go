package main

// sm dirty capture / apply: the dirty-state primitive device sync is
// built on. capture snapshots a worktree's uncommitted state (with
// `git add -A` semantics, so untracked files and deletions are in, and
// ignored files are out) as a commit on refs/shigomori/dirty/<id>
// (one ref per worktree, overwritten in place, no history). apply
// replays that commit onto a clean worktree sitting on the capture's
// parent, then consumes the ref. The staged/unstaged distinction is
// deliberately flattened: capture's add -A already collapsed it, so
// apply restores everything unstaged.
//
// Known limits, accepted: submodule-only dirt captures as clean
// (uncommitted submodule work is out of scope), skip-worktree and
// assume-unchanged bits are ignored (the real content is captured),
// and empty directories don't survive (git tracks only files).

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func dirtyRef(worktreeID string) string {
	return "refs/shigomori/dirty/" + worktreeID
}

type dirtyCaptureResult struct {
	captured     bool
	commit       string
	parent       string
	changedFiles int
}

// The number of paths the capture commit changes against its parent
// tree. diff-tree over two objects prints only the paths; -z so
// unusual filenames still count as one field each.
func dirtyChangedFiles(projectPath, from, to string) (int, error) {
	stdout, err := runGit(projectPath,
		"diff-tree", "-r", "-z", "--name-only", "--no-renames", "--end-of-options", from, to)
	if err != nil {
		return 0, err
	}
	return len(nulFields(stdout)), nil
}

// The paths the capture commit adds against its parent tree: the files
// apply would create, and so the ones to probe for collisions.
// --no-renames keeps every add an add.
func dirtyAddedPaths(projectPath, from, to string) ([]string, error) {
	stdout, err := runGit(projectPath,
		"diff-tree", "-r", "-z", "--name-only", "--diff-filter=A", "--no-renames", "--end-of-options", from, to)
	if err != nil {
		return nil, err
	}
	return nulFields(stdout), nil
}

func nulFields(stdout string) []string {
	var fields []string
	for _, field := range strings.Split(stdout, "\x00") {
		if field != "" {
			fields = append(fields, field)
		}
	}
	return fields
}

// Snapshots the worktree's dirty state to refs/shigomori/dirty/<id>.
// The whole capture runs against a temporary index (GIT_INDEX_FILE),
// so the user's real index, their carefully staged hunks, is never
// touched. The temp index is seeded from HEAD before `add -A`:
// starting empty would drop every deletion (a path missing from the
// worktree can only be recorded as deleted if the index knew it
// existed). Point-in-time like `git stash`: an edit racing the capture
// yields a slightly stale snapshot, nothing worse.
//
// `--end-of-options` is what actually pins ref arguments to the
// revision slot. A trailing `--` only bounds the pathspec list, so on
// its own it would still let a ref spelled like a flag be parsed as
// one (see getCommitDiff in host/lib/git/diff.ts). The ids here are
// hex, but the convention costs nothing.
func captureDirtyState(projectPath, worktreePath, worktreeID string) (dirtyCaptureResult, error) {
	head, err := runGit(worktreePath, "rev-parse", "HEAD")
	if err != nil {
		return dirtyCaptureResult{}, errf("Couldn't resolve the worktree's HEAD (%v).", err)
	}
	parent := strings.TrimSpace(head)

	indexDir, err := os.MkdirTemp("", "sm-dirty-")
	if err != nil {
		return dirtyCaptureResult{}, err
	}
	defer os.RemoveAll(indexDir)
	indexEnv := []string{"GIT_INDEX_FILE=" + filepath.Join(indexDir, "index")}

	// cwd stays the worktree for the index-building spawns: git resolves
	// the linked worktree's gitdir from there, and add -A scans that
	// worktree's files. Only the index location is redirected.
	if _, err := runGitEnv(worktreePath, indexEnv, "read-tree", "--end-of-options", parent); err != nil {
		return dirtyCaptureResult{}, err
	}
	if _, err := runGitEnv(worktreePath, indexEnv, "add", "-A"); err != nil {
		return dirtyCaptureResult{}, err
	}
	treeOut, err := runGitEnv(worktreePath, indexEnv, "write-tree")
	if err != nil {
		return dirtyCaptureResult{}, err
	}
	tree := strings.TrimSpace(treeOut)

	headTreeOut, err := runGit(worktreePath, "rev-parse", "HEAD^{tree}")
	if err != nil {
		return dirtyCaptureResult{}, err
	}
	if tree == strings.TrimSpace(headTreeOut) {
		// Clean. A leftover ref from an earlier capture no longer
		// describes this worktree, and a survivor would let apply replay
		// discarded changes, so this delete must succeed, not merely be
		// attempted.
		if err := deleteDirtyCapture(projectPath, worktreeID); err != nil {
			return dirtyCaptureResult{}, err
		}
		return dirtyCaptureResult{}, nil
	}

	commitOut, err := runGit(worktreePath, "commit-tree", tree, "-p", parent,
		"-m", "shigomori dirty state "+worktreeID)
	if err != nil {
		return dirtyCaptureResult{}, err
	}
	commit := strings.TrimSpace(commitOut)
	if _, err := runGit(projectPath, "update-ref", "--end-of-options", dirtyRef(worktreeID), commit); err != nil {
		return dirtyCaptureResult{}, err
	}
	changed, err := dirtyChangedFiles(projectPath, parent, commit)
	if err != nil {
		return dirtyCaptureResult{}, err
	}
	return dirtyCaptureResult{captured: true, commit: commit, parent: parent, changedFiles: changed}, nil
}

type dirtyApplyResult struct {
	commit       string
	changedFiles int
}

// Applies the capture ref onto the worktree and consumes it. Guards
// fail closed: the ref must exist, the target's HEAD must be the
// capture's parent, and the target must be clean (--force is the only
// escape). The HEAD guard runs first because it is the unforceable
// one: the sync flow fetches the branch before applying, so a
// mismatch means the caller skipped a step, and a user on the wrong
// base should learn the terminal problem before the fixable one.
func applyDirtyState(projectPath, worktreePath, worktreeID string, force bool) (dirtyApplyResult, error) {
	ref := dirtyRef(worktreeID)
	commitOut, err := runGit(projectPath, "rev-parse", "--verify", "--end-of-options", ref)
	if err != nil {
		return dirtyApplyResult{}, codedErrf("no-capture", "No dirty-state capture for this worktree.")
	}
	commit := strings.TrimSpace(commitOut)

	parentOut, err := runGit(projectPath, "rev-parse", "--verify", "--end-of-options", commit+"^")
	if err != nil {
		return dirtyApplyResult{}, err
	}
	parent := strings.TrimSpace(parentOut)
	headOut, err := runGit(worktreePath, "rev-parse", "HEAD")
	if err != nil {
		return dirtyApplyResult{}, err
	}
	if head := strings.TrimSpace(headOut); head != parent {
		return dirtyApplyResult{}, codedErrf("capture-base-mismatch",
			"The capture was taken on %.12s but this worktree is on %.12s. Sync the branch first, then apply.",
			parent, head)
	}

	// Mirrors requireClean (cmd_rm.go): an unreadable status must not
	// pass for clean when the next step overwrites the working tree.
	if !force {
		entries, err := statusEntriesUntracked(worktreePath)
		if err != nil {
			return dirtyApplyResult{}, errf(
				"Couldn't check for uncommitted changes (%v). Fix the worktree, or pass --force to apply anyway.", err)
		}
		if len(entries) > 0 {
			return dirtyApplyResult{}, errf(
				"Worktree has %d uncommitted change(s) that apply would overwrite. Commit them first, or pass --force.",
				len(entries))
		}
	}

	// read-tree -m -u refuses to overwrite an untracked file at a path
	// the capture adds, but treats ignored files as expendable and
	// clobbers them silently, and per-device ignore state
	// (.git/info/exclude, core.excludesFile) never syncs, so a path the
	// source tracks can be ignored here and hold real data. Probe every
	// added path ourselves. Unconditional: --force only skips the
	// cleanliness probe and must never make apply destructive. A user
	// who truly wants the overwrite deletes the file. Lstat so a
	// dangling symlink still counts as occupying its path.
	added, err := dirtyAddedPaths(projectPath, parent, commit)
	if err != nil {
		return dirtyApplyResult{}, err
	}
	var colliding []string
	for _, rel := range added {
		if _, statErr := os.Lstat(filepath.Join(worktreePath, rel)); statErr == nil {
			colliding = append(colliding, rel)
		}
	}
	if len(colliding) > 0 {
		named := colliding
		more := ""
		if len(named) > 3 {
			named = named[:3]
			more = fmt.Sprintf(" and %d more", len(colliding)-3)
		}
		return dirtyApplyResult{}, codedErrf("capture-overwrite",
			"Applying would overwrite existing file(s) the capture adds: %s%s. Move or delete them first.",
			strings.Join(named, ", "), more)
	}

	// Before the mutation: a transient diff-tree failure here aborts a
	// not-yet-started apply instead of mislabeling a finished one, and
	// the count never depends on a commit the consumed ref no longer
	// reaches.
	changed, err := dirtyChangedFiles(projectPath, parent, commit)
	if err != nil {
		return dirtyApplyResult{}, err
	}

	// Two-tree merge from the capture's parent to the capture: -u
	// carries the changes, deletions included, into the working
	// tree. The mixed reset then walks the index back to HEAD (which
	// equals the parent), leaving the restored state unstaged in a
	// worktree still on the same commit.
	if _, err := runGit(worktreePath, "read-tree", "-m", "-u", "--end-of-options", parent, commit); err != nil {
		return dirtyApplyResult{}, errf(
			"The worktree's local changes overlap the capture, so git refused to apply it. Commit or discard them first. (%v)",
			err)
	}
	if _, err := runGit(worktreePath, "reset", "-q"); err != nil {
		return dirtyApplyResult{}, err
	}
	dropDirtyCapture(projectPath, worktreeID)
	return dirtyApplyResult{commit: commit, changedFiles: changed}, nil
}

// Deletes the capture ref. Absence is fine, update-ref -d on a
// missing ref exits 0, so every error here is real.
func deleteDirtyCapture(projectPath, worktreeID string) error {
	_, err := runGit(projectPath, "update-ref", "-d", "--end-of-options", dirtyRef(worktreeID))
	return err
}

// Best-effort variant for apply's consume and rm's cleanup, where the
// restore or removal already happened and a survivor is only clutter.
func dropDirtyCapture(projectPath, worktreeID string) {
	if err := deleteDirtyCapture(projectPath, worktreeID); err != nil {
		vlog("[dirty] ref delete skipped: %v", err)
	}
}

func cmdDirty(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.bools["force"] = []string{"f"}
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	verb := parsed.positional(0)
	if verb != "capture" && verb != "apply" {
		return 2, usageErrf("Usage: %s dirty <capture|apply> [<name>] [-f]", binaryName)
	}
	// Shift the verb off so the shared resolver sees the worktree name
	// in its usual slot.
	parsed.positionals = parsed.positionals[1:]
	target, err := resolveWorktreeArgs(ctx, parsed, true)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree

	if verb == "capture" {
		res, err := captureDirtyState(proj.Path, id.Path, id.ID)
		if err != nil {
			return exitCodeOf(err), err
		}
		if jsonMode {
			doc := map[string]any{"ok": true, "captured": res.captured}
			if res.captured {
				doc["commit"] = res.commit
				doc["parent"] = res.parent
				doc["changedFiles"] = res.changedFiles
			}
			emit(doc)
		} else if res.captured {
			out(greenOut(fmt.Sprintf("captured %d change(s) from %s", res.changedFiles, id.Name)))
		} else {
			out("nothing to capture -- " + id.Name + " is clean")
		}
		return 0, nil
	}

	res, err := applyDirtyState(proj.Path, id.Path, id.ID, parsed.bools["force"])
	if err != nil {
		return exitCodeOf(err), err
	}
	if jsonMode {
		emit(map[string]any{"ok": true, "applied": true, "commit": res.commit, "changedFiles": res.changedFiles})
	} else {
		out(greenOut(fmt.Sprintf("applied %d change(s) to %s", res.changedFiles, id.Name)))
	}
	return 0, nil
}
