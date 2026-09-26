package main

// sm land is the finish line as one command. It merges the worktree's
// PR (the sm merge flow), fast-forwards the checkout holding the PR's
// base branch so it sees the merge, and cleans up: the sm rm pipeline
// for a managed or external worktree, or the sm done switch-and-delete
// when landing the primary checkout itself. A PR that's already merged
// skips straight to cleanup, so re-running after a partial failure
// (say a teardown script) resumes where it left off.
//
// --stack lands a layer of a stack: the PR with every open PR under it
// (the sm merge --stack flow), then the cleanup for every worktree
// whose branch landed, the layers under this one included. Without
// it, a PR that sits on another open PR is refused: merging it alone
// would fold it into the layer below, not the trunk, and land would
// then remove the worktree as if the work had landed.

import (
	"cmp"
	"errors"
	"fmt"
	"slices"
	"strings"
)

func cmdLand(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.strings["method"] = []string{"m"}
	spec.bools["stack"] = []string{}
	addRemoveFlags(spec)
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	methodFlag, err := mergeMethodOf(parsed)
	if err != nil {
		return exitCodeOf(err), err
	}

	target, err := resolveWorktreeArgs(ctx, parsed, true)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree
	if id.Branch == unknownBranch || id.Detached {
		return 1, errf("No branch checked out to land")
	}

	// Run the removal guards before touching the remote: uncommitted
	// work wouldn't be in the PR being merged.
	opts := removeOptionsFrom(parsed)
	if !id.IsPrimary {
		if err := removePreflight(id, opts.force); err != nil {
			return exitCodeOf(err), err
		}
		opts.preflighted = true
	}

	pr, allowed, err := resolveMergeTarget(proj.Path, id.Branch)
	if err != nil {
		return 1, err
	}
	if pr == nil {
		return 1, errf("No pull request found for branch %s. Push the branch and open a PR first", id.Branch)
	}
	if pr.State != "OPEN" && pr.State != "MERGED" {
		return 1, errf("PR #%d for %s is %s, not open. Reopen it, or clean up with `%s rm %s`",
			pr.Number, id.Branch, strings.ToLower(pr.State), binaryName, id.Name)
	}
	if parsed.bools["stack"] {
		return landStack(proj, id, pr, methodFlag, allowed, opts)
	}

	// Resolved once for the guard below and the cleanup after. A
	// failure only skips the guard and the catch-up (landCleanup says
	// so), since neither is the land.
	pt, ptErr := resolvePrimaryTarget(proj)
	method := ""
	if pr.State == "OPEN" {
		if below, err := stackedUnder(proj, pr, pt, ptErr); err != nil {
			return 1, err
		} else if below != nil {
			return 1, errf("PR #%d (%s) is stacked on open PR #%d (%s). `%s land --stack` lands both. "+
				"to merge it into %s alone, `%s merge` then `%s rm %s`",
				pr.Number, id.Branch, below.Number, below.HeadRefName, binaryName,
				below.HeadRefName, binaryName, binaryName, id.Name)
		}
		var queued bool
		method, queued, err = execMerge(proj, pr.Number, methodFlag, allowed)
		if err != nil {
			return exitCodeOf(err), err
		}
		if queued {
			return reportQueued(pr, id, method)
		}
	}
	reportMerged(pr, method)
	extra := map[string]any{"merged": mergeResultFields(pr, id.Branch, method)}
	return landCleanup(proj, id, pr.BaseRefName, pt, ptErr, opts, extra)
}

// A merge queue took the PR: nothing has landed, so nothing is cleaned
// up. Running land again once the queue is through does the rest (the
// merged PR resumes with cleanup).
func reportQueued(pr *prSummary, id worktreeIdentity, method string) (int, error) {
	if jsonMode {
		doc := mergeResultFields(pr, id.Branch, method)
		doc["ok"] = true
		doc["queued"] = true
		emit(doc)
	} else {
		out(greenOut(fmt.Sprintf("queued PR #%d (%s): %s", pr.Number, method, pr.Title)))
		note(dimErr(fmt.Sprintf("nothing removed yet. Run `%s land` again once the queue has merged it", binaryName)))
	}
	return 0, nil
}

// The open PR this PR is based on, or nil when it sits on the trunk
// (or on a branch with no open PR). One `gh pr list --head` lookup,
// and only when the base isn't the trunk, so the common land pays
// nothing. A trunk that couldn't be resolved skips the check: it's a
// guard, not the merge.
func stackedUnder(proj project, pr *prSummary, pt primaryTarget, ptErr error) (*prSummary, error) {
	if ptErr != nil || pr.BaseRefName == "" || pr.BaseRefName == pt.localPrimary {
		return nil, nil
	}
	below, err := findPullRequest(proj.Path, pr.BaseRefName)
	if err != nil {
		return nil, err
	}
	if below == nil || below.State != "OPEN" {
		return nil, nil
	}
	return below, nil
}

func reportMerged(pr *prSummary, method string) {
	if jsonMode {
		return
	}
	if method == "" {
		note(dimErr(fmt.Sprintf("PR #%d already merged: %s", pr.Number, pr.Title)))
	} else {
		out(greenOut(fmt.Sprintf("merged PR #%d (%s): %s", pr.Number, method, pr.Title)))
	}
}

// The --stack arm. The removal guards run for every worktree the land
// will remove before anything merges, like the plain land's own guard:
// uncommitted work in a lower layer's worktree isn't in the PRs about
// to land either. An already-merged PR resumes with cleanup, which
// then covers the layers under it that are merged too.
func landStack(proj project, id worktreeIdentity, pr *prSummary, methodFlag string, allowed []string, opts removeOptions) (int, error) {
	lk, err := lookupStack(proj, pr.Number, allowed, pr.State == "OPEN")
	if err != nil {
		return exitCodeOf(err), err
	}
	chain, err := stackChain(proj, pr.Number, lk)
	if err != nil {
		return exitCodeOf(err), err
	}
	var set []prSummary
	method := ""
	if pr.State == "OPEN" {
		if set, err = stackMergeSet(chain); err != nil {
			return exitCodeOf(err), err
		}
		if method, err = resolveMergeMethod(proj, methodFlag, lk.allowed); err != nil {
			return exitCodeOf(err), err
		}
	}
	plan, err := planStackCleanup(proj, id, chain, set, opts)
	if err != nil {
		return exitCodeOf(err), err
	}

	if pr.State == "OPEN" {
		queued, err := mergeStackSet(proj, pr.Number, method, lk, chain, set, stackMergedReporter(method))
		if err != nil {
			return exitCodeOf(err), err
		}
		persistMergeMethod(proj, method)
		if queued {
			return reportQueued(pr, id, method)
		}
	} else {
		reportMerged(pr, "")
	}
	extra := map[string]any{"merged": mergeResultFields(pr, id.Branch, method)}
	return execStackCleanup(proj, id, pr, true, plan, lk.pt, opts, extra)
}

// `rm --stack`: the cleanup half of a stack land on its own, for a
// stack that has landed. Never merges: an open PR is refused with the
// land to run. Any worktree of the stack will do, since the layers
// under it that are merged go with it.
func rmStack(proj project, id worktreeIdentity, opts removeOptions) (int, error) {
	if id.Branch == unknownBranch || id.Detached {
		return 1, errf("No branch checked out")
	}
	if err := removePreflight(id, opts.force); err != nil {
		return exitCodeOf(err), err
	}
	opts.preflighted = true
	pr, err := findPullRequest(proj.Path, id.Branch)
	if err != nil {
		return 1, err
	}
	switch {
	case pr == nil:
		return 1, errf("No pull request found for branch %s, so no stack to clean up", id.Branch)
	case pr.State == "OPEN":
		return 1, errf("PR #%d for %s is still open. `%s land --stack` lands it", pr.Number, id.Branch, binaryName)
	}
	// Neither the allowed merge methods nor GitHub's stack object are
	// needed: nothing merges.
	lk, err := lookupStack(proj, pr.Number, mergeMethodOrder, false)
	if err != nil {
		return exitCodeOf(err), err
	}
	chain, err := stackChain(proj, pr.Number, lk)
	if err != nil {
		return exitCodeOf(err), err
	}
	plan, err := planStackCleanup(proj, id, chain, nil, opts)
	if err != nil {
		return exitCodeOf(err), err
	}
	return execStackCleanup(proj, id, pr, pr.State == "MERGED", plan, lk.pt, opts, nil)
}

// What a stack cleanup removes: the layers landed once the merge is
// through, and the worktrees on them besides this one, every one of
// them past the removal guards.
type stackCleanupPlan struct {
	chain      []prSummary
	landing    map[string]bool
	identities []worktreeIdentity
	others     []worktreeIdentity
}

func planStackCleanup(proj project, id worktreeIdentity, chain, set []prSummary, opts removeOptions) (stackCleanupPlan, error) {
	plan := stackCleanupPlan{chain: chain, landing: landingLayers(chain, set)}
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		return plan, err
	}
	plan.identities = identities
	plan.others = landedWorktrees(identities, plan.landing, id)
	for _, other := range plan.others {
		if err := removePreflight(other, opts.force); err != nil {
			return plan, errf("worktree %s (%s): %s", other.Name, other.Branch, err)
		}
	}
	return plan, nil
}

// The removals: the other landed worktrees first, then this one
// through the plain cleanup, whose document carries the landed layers
// (bottom first, the command's own PR among them only when it merged,
// ownLanded, since rm --stack removes a closed one's worktree too) and
// the worktrees removed for them. The catch-up targets the bottom's
// base, the branch the stack landed on, not this PR's own base (the
// layer below).
func execStackCleanup(proj project, id worktreeIdentity, pr *prSummary, ownLanded bool, plan stackCleanupPlan, pt primaryTarget, opts removeOptions, extra map[string]any) (int, error) {
	landed := make([]map[string]any, 0, len(plan.chain))
	for _, layer := range plan.chain {
		if plan.landing[layer.HeadRefName] || (ownLanded && layer.Number == pr.Number) {
			landed = append(landed, map[string]any{
				"number": layer.Number, "title": layer.Title, "branch": layer.HeadRefName, "url": layer.URL,
			})
		}
	}
	removed := make([]map[string]any, 0, len(plan.others))
	stackDoc := map[string]any{"landed": landed, "removed": removed}
	if extra == nil {
		extra = map[string]any{}
	}
	extra["stack"] = stackDoc
	base := plan.chain[0].BaseRefName
	// The primary checkout is never removed. It stays where the sm done
	// flow can land it back on the trunk.
	if !id.IsPrimary && !jsonMode {
		for _, other := range plan.identities {
			if other.IsPrimary && plan.landing[other.Branch] {
				note(dimErr(fmt.Sprintf("the primary checkout is on landed branch %s. `%s done` lands it back on %s",
					other.Branch, binaryName, base)))
			}
		}
	}
	for _, other := range plan.others {
		if _, err := execRemove(proj, other, opts); err != nil {
			return landCleanupFailed(err, extra)
		}
		removed = append(removed, removedFields(proj, other))
		stackDoc["removed"] = removed
		if !jsonMode {
			out(greenOut("removed " + other.Name))
		}
	}
	return landCleanup(proj, id, base, pt, nil, opts, extra)
}

// The head branches of the layers under the landing PR (the chain
// ends in it) that are landed once the merge is through: the ones
// merged before, and the ones the merge set lands now. Every other
// layer refused the merge (a closed one) or wasn't merged (a resume
// whose lower layer is still open landed nothing there).
func landingLayers(chain, set []prSummary) map[string]bool {
	landing := map[string]bool{}
	for _, layer := range chain[:len(chain)-1] {
		if layer.State == "MERGED" || slices.ContainsFunc(set, func(p prSummary) bool { return p.Number == layer.Number }) {
			landing[layer.HeadRefName] = true
		}
	}
	return landing
}

// The worktrees a stack land removes besides its own: each one on a
// landed layer's branch, in the order they are listed. The primary
// checkout stays (the sm done flow is its way back to the trunk), and
// so does a detached checkout, which is on no branch at all.
func landedWorktrees(identities []worktreeIdentity, landing map[string]bool, self worktreeIdentity) []worktreeIdentity {
	var others []worktreeIdentity
	for _, other := range identities {
		if landing[other.Branch] && other.ID != self.ID && !other.Detached && !other.IsPrimary {
			others = append(others, other)
		}
	}
	return others
}

// The cleanup half of land, after the merge: catch the base branch's
// checkout up, then remove the worktree, or land the primary checkout
// back on the primary branch. extra holds the fields the final
// document carries either way (the merge, a stack's removals). ptErr
// is a primary target that couldn't be resolved, which the primary
// checkout can't do without and a worktree only loses the catch-up to.
func landCleanup(proj project, id worktreeIdentity, base string, pt primaryTarget, ptErr error, opts removeOptions, extra map[string]any) (int, error) {
	// Landing the primary checkout itself is the sm done flow, minus
	// its is-it-merged guard, since the merge just happened above.
	if id.IsPrimary {
		if ptErr != nil {
			return 1, ptErr
		}
		deleted, err := execDone(proj, pt, id, !opts.keepBranch)
		if err != nil {
			return 1, err
		}
		w, err := describeAfterDone(proj, pt, id)
		if err != nil {
			return 1, err
		}
		// execDone already pulled the primary branch. A PR into another
		// line still leaves that line's checkout behind.
		if base != "" && base != pt.localPrimary {
			cu := catchUpBase(proj, pt, base)
			cu.report()
			cu.addTo(extra)
		}
		reportDone(w, id.Branch, deleted, extra)
		return 0, nil
	}

	var cu catchUpResult
	if ptErr != nil {
		cu.skip = ptErr.Error()
	} else {
		cu = catchUpBase(proj, pt, base)
	}
	cu.report()
	cu.addTo(extra)

	hint, err := execRemove(proj, id, opts)
	if err != nil {
		return landCleanupFailed(err, extra)
	}
	reportRemoved(proj, id, hint, extra)
	return 0, nil
}

// A cleanup failure after the merge. The JSON document keeps the merge
// fields: one that omitted them would read as "nothing changed" to the
// app or an agent.
func landCleanupFailed(err error, doc map[string]any) (int, error) {
	if !jsonMode {
		return exitCodeOf(err), err
	}
	doc["ok"] = false
	var ce *cleanupError
	if errors.As(err, &ce) {
		doc["cleanupError"] = cleanupErrorDoc(ce)
	} else {
		doc["error"] = jsonErrorMessage(err)
		if kind := errorKindOf(err); kind != "" {
			doc["code"] = kind
		}
	}
	emit(doc)
	return 1, nil
}

// Outcome of the post-merge catch-up: the checkout pulled and the
// ref it was pulled from, or why nothing was.
type catchUpResult struct {
	checkout worktreeIdentity
	ref      string // empty when skipped
	skip     string
}

func (cu catchUpResult) report() {
	if jsonMode {
		return
	}
	switch {
	case cu.ref != "":
		label := "worktree " + cu.checkout.Name
		if cu.checkout.IsPrimary {
			label = "primary checkout"
		}
		note(dimErr(fmt.Sprintf("%s caught up (%s)", label, cu.ref)))
	case cu.skip != "":
		note(dimErr("skipped catch-up: " + cu.skip))
	}
}

// JSON fields for the land document: caughtUp names the pulled
// checkout on success, catchUpSkipped carries the reason otherwise.
func (cu catchUpResult) addTo(doc map[string]any) {
	switch {
	case cu.ref != "":
		doc["caughtUp"] = map[string]any{
			"ref": cu.ref, "name": cu.checkout.Name,
			"path": cu.checkout.Path, "isPrimary": cu.checkout.IsPrimary,
		}
	case cu.skip != "":
		doc["catchUpSkipped"] = cu.skip
	}
}

// Best-effort fast-forward of the checkout holding the PR's base
// branch after the merge, so the local branch sees what just landed.
// A PR based on a release line or a long-lived feature branch leaves
// the primary branch untouched, so pulling the primary checkout would
// advance it by unrelated commits and report a catch-up that never
// happened, and leave the line that did move behind, inviting a
// by-hand fast-forward that can land in the wrong checkout. Only the
// base branch's own checkout is touched, and ffPull refuses unless
// that checkout really is on the base branch, so nothing else can
// move.
//
// An empty prBase means the base could not be read, which keeps the
// old behavior of pulling the primary branch: the default base is
// overwhelmingly the common one, so guessing it beats skipping.
//
// Skipped when the primary ref has no remote or no checkout has the
// base branch out. Failures never abort the command. The merge and
// the cleanup are the substance of land.
func catchUpBase(proj project, pt primaryTarget, prBase string) catchUpResult {
	base := cmp.Or(prBase, pt.localPrimary)
	if pt.remote == "" {
		return catchUpResult{skip: "primary ref " + pt.primaryRef + " has no remote"}
	}
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		return catchUpResult{skip: err.Error()}
	}
	checkout, ok := checkoutOn(identities, base)
	if !ok {
		return catchUpResult{skip: "no checkout is on " + base}
	}
	if err := ffPull(checkout.Path, pt.remote, base); err != nil {
		return catchUpResult{skip: err.Error()}
	}
	return catchUpResult{checkout: checkout, ref: pt.remote + "/" + base}
}
