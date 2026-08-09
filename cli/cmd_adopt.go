package main

// sm adopt: convert an external worktree (made with raw git or
// another tool) into a shigomori-managed one, ported from
// convertExternalWorktree in main/lib/worktrees/operations.ts. The
// external's branch (or detached short hash) is re-checked-out at the
// managed location: name-collision check BEFORE the destructive wipe
// (so a failure can't strand the user with neither checkout),
// force-remove the old directory, `git worktree add` at the managed
// path in checkout mode, then the full create lifecycle (carry-over,
// setup, port-pool). Externals never got teardown/port-release on the
// way out -- the app never provisioned them.

import "strings"

func cmdAdopt(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.bools["force"] = []string{"f"}
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	target, err := resolveWorktreeArgs(ctx, parsed)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree

	if id.IsPrimary {
		return 1, errf("The primary checkout can't be converted")
	}
	if !id.IsExternal {
		return 1, errf("Worktree is already shigomori-managed")
	}
	// Adopting wipes the old directory and re-checks-out the branch
	// tip, so anything uncommitted (or untracked) there is destroyed.
	// The app's convert flow carries this in its confirmation dialog;
	// the CLI needs the guard itself.
	if !parsed.bools["force"] {
		// Fail closed: an unreadable status must not pass for clean when
		// adopting wipes the directory.
		changed, err := changedCount(id.Path)
		if err != nil {
			return 1, errf("Couldn't check for uncommitted changes (%v). Fix the worktree, or pass --force to adopt anyway.", err)
		}
		if changed > 0 {
			return 1, errf(
				"Worktree has %d uncommitted change(s) that adopting would destroy. Commit them first, or pass --force.",
				changed)
		}
	}

	branchOrSha := id.Branch
	worktreeName := branchOrSha
	if !id.Detached {
		worktreeName = sanitizeBranchForPath(branchOrSha)
	}

	// Refuse a name collision BEFORE the wipe below -- createWorktree's
	// own check runs after the old directory is already gone.
	if worktreeName != "" {
		identities, err := listWorktreeIdentities(proj)
		if err != nil {
			return 1, err
		}
		for _, other := range identities {
			if other.ID != id.ID && strings.EqualFold(other.Name, worktreeName) {
				return 1, errf(`A worktree folder named "%s" already exists in this project.`, worktreeName)
			}
		}
	}

	// The old directory is about to be removed; if the shell is inside
	// it, every later git call from this process still works (they run
	// against proj/new paths), but warn so the user knows to move.
	wasInside := cwdInside(id.Path)

	if err := removeWorktreeForce(proj.Path, id.Path); err != nil {
		return 1, err
	}
	invalidateWorktreeIdentities(proj.ID)
	if err := dropShelved(id.ID); err != nil {
		vlog("[state] drop shelved: %v", err)
	}

	worktree, err := createWorktree(proj, worktreeName, "", branchOrSha, true)
	if err != nil {
		return 1, err
	}
	if jsonMode {
		emit(map[string]any{"event": "created", "worktree": worktree})
	} else {
		note("adopted " + id.Path + " as " + cyanErr(worktree.Name) + " (branch " + cyanErr(worktree.Branch) + ")")
	}
	code := finishCreateLifecycle(proj, worktree)
	if wasInside && !jsonMode {
		note(dimErr("note: your shell is inside the old location -- cd " + worktree.Path))
	}
	return code, nil
}
