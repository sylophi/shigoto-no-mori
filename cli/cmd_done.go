package main

// sgm done: post-merge cleanup, ported from
// switchToPrimaryAndDeleteBranch in main/lib/git/sync.ts and its IPC
// handler -- land the worktree back on the project's primary branch
// (creating a local tracking branch from the remote ref when needed,
// then --ff-only pulling it current) and delete the now-merged branch
// it was sitting on. Order matters: the checkout frees the merged
// branch (git refuses to delete a checked-out branch). The branch we
// just landed on is never deleted.
//
// Note: git refuses to check out a branch already checked out in
// another worktree, so this flow fits a checkout sitting on a merged
// feature branch -- classically the primary checkout. For a managed
// worktree you're done with entirely, `sgm rm` is the cleanup.

import "fmt"

func cmdDone(ctx cliContext, args []string) (int, error) {
	parsed, err := parseCmdArgs(args, argSpec{
		strings: map[string][]string{"project": {"p"}},
	})
	if err != nil {
		return exitCodeOf(err), err
	}
	ref := ""
	if len(parsed.positionals) > 0 {
		ref = parsed.positionals[0]
	}
	target, err := resolveWorktree(ctx, ref, parsed.strings["project"])
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree

	if id.Branch == unknownBranch || id.Detached {
		return 1, errf("No branch checked out to clean up")
	}

	config := readProjectConfig(proj.ID)
	override := ""
	if config != nil {
		override = config.DefaultBranch
	}
	primaryRef := resolveDefaultBranch(proj.Path, override)
	if primaryRef == "" {
		return 1, errf("No local branches found in %s", proj.Path)
	}

	mergedBranch := id.Branch
	if err := switchToPrimaryBranch(id.Path, proj.Path, primaryRef); err != nil {
		return 1, err
	}
	remotes := listRemotes(proj.Path)
	localPrimary := primaryRef
	if _, branch := splitRemoteRef(primaryRef, remotes); branch != "" {
		localPrimary = branch
	}
	deleted := false
	if mergedBranch != localPrimary {
		if _, err := runGit(proj.Path, "branch", "-D", "--", mergedBranch); err != nil {
			return 1, err
		}
		deleted = true
	}

	// Fresh description so callers see the landed state, matching the
	// app's mutateAndDescribe round trip.
	fresh, err := listWorktreeIdentities(proj)
	if err != nil {
		return 1, err
	}
	for _, freshID := range fresh {
		if freshID.ID != id.ID {
			continue
		}
		w := buildWorktree(proj, freshID, loadBuildContext(proj))
		w.ProjectName = proj.Name
		if jsonMode {
			emit(map[string]any{
				"ok": true, "worktree": w,
				"deletedBranch": deletedBranchField(mergedBranch, deleted),
			})
		} else {
			line := fmt.Sprintf("%s is now on %s", w.Name, w.Branch)
			if deleted {
				line += fmt.Sprintf(" (deleted branch %s)", mergedBranch)
			}
			out(line)
		}
		return 0, nil
	}
	return 1, errf("worktree disappeared after switching branches")
}

func deletedBranchField(branch string, deleted bool) any {
	if deleted {
		return branch
	}
	return nil
}

// switchToPrimaryBranch ports sync.ts: checkout the primary ref (via
// the checkoutBranch precedence rules), then --ff-only pull when it
// resolved to a remote-tracking ref.
func switchToPrimaryBranch(worktreePath, projectPath, primaryRef string) error {
	remotes := listRemotes(projectPath)
	if err := checkoutBranch(worktreePath, primaryRef, remotes); err != nil {
		return err
	}
	if remote, branch := splitRemoteRef(primaryRef, remotes); remote != "" {
		if _, err := runGit(worktreePath, "pull", "--ff-only", remote, branch); err != nil {
			return err
		}
	}
	return nil
}

// checkoutBranch ports branches.ts: an exact local branch wins; a
// qualified remote ref whose local branch doesn't exist yet gets a
// tracking branch from the explicit ref (so a name shared across
// remotes stays unambiguous); otherwise checkout the stripped name.
func checkoutBranch(worktreePath, branch string, remotes []string) error {
	if localBranchExists(worktreePath, branch) {
		_, err := runGit(worktreePath, "checkout", branch)
		return err
	}
	remote, stripped := splitRemoteRef(branch, remotes)
	if remote != "" && !localBranchExists(worktreePath, stripped) {
		_, err := runGit(worktreePath, "checkout", "--track", branch)
		return err
	}
	if remote != "" {
		branch = stripped
	}
	_, err := runGit(worktreePath, "checkout", branch)
	return err
}
