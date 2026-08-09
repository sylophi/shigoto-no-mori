package main

// sm done: post-merge cleanup, ported from
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
// worktree you're done with entirely, `sm rm` is the cleanup.

import (
	"encoding/json"
	"fmt"
)

func cmdDone(ctx cliContext, args []string) (int, error) {
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

	if id.Branch == unknownBranch || id.Detached {
		return 1, errf("No branch checked out to clean up")
	}

	config := readProjectConfig(proj.ID)
	override := ""
	if config != nil {
		override = config.DefaultBranch
	}
	// One `git remote` spawn serves the primary-ref resolution, the
	// local-name split below, and the checkout inside
	// switchToPrimaryBranch.
	remotes := listRemotes(proj.Path)
	primaryRef := resolveDefaultBranchWithRemotes(proj.Path, override, remotes)
	if primaryRef == "" {
		return 1, errf("No local branches found in %s", proj.Path)
	}

	mergedBranch := id.Branch
	localPrimary := primaryRef
	if _, branch := splitRemoteRef(primaryRef, remotes); branch != "" {
		localPrimary = branch
	}

	// The delete below is `branch -D`, so refuse before mutating
	// anything unless the branch is verifiably merged: an ancestor of
	// the primary ref (merge/rebase merges), or the head of a merged PR
	// (squash merges leave no ancestor relationship). --force covers
	// intentional discards.
	if mergedBranch != localPrimary && !parsed.bools["force"] &&
		!isAncestor(proj.Path, mergedBranch, primaryRef) &&
		!branchHasMergedPR(proj.Path, mergedBranch) {
		return 1, errf(
			"Branch %s isn't merged into %s (no merge found, no merged PR). Merge it first, or pass --force to discard it.",
			mergedBranch, primaryRef)
	}

	if err := switchToPrimaryBranch(id.Path, primaryRef, remotes); err != nil {
		return 1, err
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
	invalidateWorktreeIdentities(proj.ID)
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
			line := greenOut(fmt.Sprintf("%s is now on %s", w.Name, w.Branch))
			if deleted {
				line += dimOut(fmt.Sprintf(" (deleted branch %s)", mergedBranch))
			}
			out(line)
		}
		return 0, nil
	}
	return 1, errf("worktree disappeared after switching branches")
}

func isAncestor(cwd, ancestor, ref string) bool {
	_, err := runGit(cwd, "merge-base", "--is-ancestor", ancestor, ref)
	return err == nil
}

// True when gh reports a merged PR whose head is the branch. False on
// any gh failure (not installed, not a GitHub repo): the caller then
// requires --force rather than guessing.
func branchHasMergedPR(projectPath, branch string) bool {
	stdout, err := runGh(projectPath,
		"pr", "list", "--state", "merged", "--head", branch, "--limit", "1",
		"--json", "number")
	if err != nil {
		return false
	}
	var prs []struct {
		Number int `json:"number"`
	}
	return json.Unmarshal([]byte(stdout), &prs) == nil && len(prs) > 0
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
func switchToPrimaryBranch(worktreePath, primaryRef string, remotes []string) error {
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
