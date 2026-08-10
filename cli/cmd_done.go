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

// The project's primary branch in every form the flows below need:
// the resolved ref (possibly remote-qualified), the bare local branch
// name, and the remotes list that fed the resolution -- one `git
// remote` spawn serves the ref resolution, the local-name split, and
// the checkout inside switchToPrimaryBranch.
type primaryTarget struct {
	remotes      []string
	primaryRef   string
	localPrimary string
}

func resolvePrimaryTarget(proj project) (primaryTarget, error) {
	remotes := listRemotes(proj.Path)
	primaryRef := resolveDefaultBranchWithRemotes(proj.Path,
		defaultBranchOverride(readProjectConfig(proj.ID)), remotes)
	if primaryRef == "" {
		return primaryTarget{}, errf("No local branches found in %s", proj.Path)
	}
	localPrimary := primaryRef
	if _, branch := splitRemoteRef(primaryRef, remotes); branch != "" {
		localPrimary = branch
	}
	return primaryTarget{remotes: remotes, primaryRef: primaryRef, localPrimary: localPrimary}, nil
}

// execDone lands the checkout back on the primary branch and (when
// deleteBranch is set) deletes the branch it was sitting on. Returns
// whether a branch was deleted. Order matters: the checkout frees the
// merged branch (git refuses to delete a checked-out branch). The
// branch just landed on is never deleted.
func execDone(proj project, pt primaryTarget, id worktreeIdentity, deleteBranch bool) (bool, error) {
	if err := switchToPrimaryBranch(id.Path, pt.primaryRef, pt.remotes); err != nil {
		return false, err
	}
	if deleteBranch && id.Branch != pt.localPrimary {
		if _, err := runGit(proj.Path, "branch", "-D", "--", id.Branch); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, nil
}

// Fresh description so callers see the landed state, matching the
// app's mutateAndDescribe round trip. pt already holds what
// loadBuildContext would re-spawn git for.
func describeAfterDone(proj project, pt primaryTarget, id worktreeIdentity) (worktreeJSON, error) {
	invalidateWorktreeIdentities(proj.ID)
	fresh, err := listWorktreeIdentities(proj)
	if err != nil {
		return worktreeJSON{}, err
	}
	ctx := buildContext{
		hasRemote:  len(pt.remotes) > 0,
		primaryRef: pt.primaryRef,
		shelved:    readShelvedSet(),
	}
	for _, freshID := range fresh {
		if freshID.ID != id.ID {
			continue
		}
		w := buildWorktree(proj, freshID, ctx)
		w.ProjectName = proj.Name
		return w, nil
	}
	return worktreeJSON{}, errf("worktree disappeared after switching branches")
}

// Shared result report for done and land's primary path. extra adds
// top-level keys to the JSON document (land's "merged").
func reportDone(w worktreeJSON, mergedBranch string, deleted bool, extra map[string]any) {
	if jsonMode {
		doc := map[string]any{
			"ok": true, "worktree": w,
			"deletedBranch": deletedBranchField(mergedBranch, deleted),
		}
		for key, value := range extra {
			doc[key] = value
		}
		emit(doc)
	} else {
		line := greenOut(fmt.Sprintf("%s is now on %s", w.Name, w.Branch))
		if deleted {
			line += dimOut(fmt.Sprintf(" (deleted branch %s)", mergedBranch))
		}
		out(line)
	}
}

func cmdDone(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.bools["force"] = []string{"f"}
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	target, err := resolveWorktreeArgs(ctx, parsed, true)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree

	if id.Branch == unknownBranch || id.Detached {
		return 1, errf("No branch checked out to clean up")
	}

	pt, err := resolvePrimaryTarget(proj)
	if err != nil {
		return 1, err
	}

	// The delete below is `branch -D`, so refuse before mutating
	// anything unless the branch is verifiably merged: an ancestor of
	// the primary ref (merge/rebase merges), or the head of a merged PR
	// (squash merges leave no ancestor relationship). --force covers
	// intentional discards.
	if id.Branch != pt.localPrimary && !parsed.bools["force"] &&
		!isAncestor(proj.Path, id.Branch, pt.primaryRef) &&
		!branchHasMergedPR(proj.Path, id.Branch) {
		return 1, errf(
			"Branch %s isn't merged into %s (no merge found, no merged PR). Merge it first, or pass --force to discard it.",
			id.Branch, pt.primaryRef)
	}

	deleted, err := execDone(proj, pt, id, true)
	if err != nil {
		return 1, err
	}

	w, err := describeAfterDone(proj, pt, id)
	if err != nil {
		return 1, err
	}
	reportDone(w, id.Branch, deleted, nil)
	return 0, nil
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
	_, err := ffPullPrimary(worktreePath, primaryRef, remotes)
	return err
}

// Fast-forward worktreePath from the remote side of primaryRef; a
// local-only ref is a no-op. Reports whether a pull actually ran.
func ffPullPrimary(worktreePath, primaryRef string, remotes []string) (bool, error) {
	remote, branch := splitRemoteRef(primaryRef, remotes)
	if remote == "" {
		return false, nil
	}
	_, err := runGit(worktreePath, "pull", "--ff-only", remote, branch)
	return err == nil, err
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
