package main

// sm land: the finish line as one command -- merge the worktree's PR
// (the sm merge flow), fast-forward the checkout holding the PR's
// base branch so it sees the merge, and clean up: the sm rm pipeline
// for a managed or external worktree, or the sm done switch-and-delete
// when landing the primary checkout itself. A PR that's already merged skips
// straight to cleanup, so re-running after a partial failure (say a
// teardown script) resumes where it left off.

import (
	"cmp"
	"errors"
	"fmt"
	"strings"
)

func cmdLand(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.strings["method"] = []string{"m"}
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
		return 1, errf("No pull request found for branch %s -- push the branch and open a PR first", id.Branch)
	}
	alreadyMerged := pr.State == "MERGED"
	method := ""
	switch {
	case pr.State == "OPEN":
		method, err = execMerge(proj, pr.Number, methodFlag, allowed)
		if err != nil {
			return exitCodeOf(err), err
		}
	case alreadyMerged:
		// Merged on a previous run (or by hand): resume with cleanup.
	default:
		return 1, errf("PR #%d for %s is %s, not open -- reopen it, or clean up with `%s rm %s`",
			pr.Number, id.Branch, strings.ToLower(pr.State), binaryName, id.Name)
	}

	mergedDoc := mergeResultFields(pr, id.Branch, method)
	if !jsonMode {
		if alreadyMerged {
			note(dimErr(fmt.Sprintf("PR #%d already merged: %s", pr.Number, pr.Title)))
		} else {
			out(greenOut(fmt.Sprintf("merged PR #%d (%s): %s", pr.Number, method, pr.Title)))
		}
	}

	// Landing the primary checkout itself is the sm done flow, minus
	// its is-it-merged guard -- the merge just happened above.
	if id.IsPrimary {
		pt, err := resolvePrimaryTarget(proj)
		if err != nil {
			return 1, err
		}
		deleted, err := execDone(proj, pt, id, !opts.keepBranch)
		if err != nil {
			return 1, err
		}
		w, err := describeAfterDone(proj, pt, id)
		if err != nil {
			return 1, err
		}
		extra := map[string]any{"merged": mergedDoc}
		// execDone already pulled the primary branch. A PR into another
		// line still leaves that line's checkout behind.
		if pr.BaseRefName != "" && pr.BaseRefName != pt.localPrimary {
			cu := catchUpBase(proj, pt, pr.BaseRefName)
			cu.report()
			cu.addTo(extra)
		}
		reportDone(w, id.Branch, deleted, extra)
		return 0, nil
	}

	var cu catchUpResult
	if pt, err := resolvePrimaryTarget(proj); err != nil {
		cu.skip = err.Error()
	} else {
		cu = catchUpBase(proj, pt, pr.BaseRefName)
	}
	cu.report()

	hint, err := execRemove(proj, id, opts)
	if err != nil {
		// The merge already happened; a JSON error document that omitted
		// it would read as "nothing changed" to the app or an agent.
		if jsonMode {
			doc := map[string]any{"ok": false, "merged": mergedDoc}
			cu.addTo(doc)
			var ce *cleanupError
			if errors.As(err, &ce) {
				doc["cleanupError"] = cleanupErrorDoc(ce)
			} else {
				doc["error"] = err.Error()
				if kind := errorKindOf(err); kind != "" {
					doc["code"] = kind
				}
			}
			emit(doc)
			return 1, nil
		}
		return exitCodeOf(err), err
	}

	extra := map[string]any{"merged": mergedDoc}
	cu.addTo(extra)
	reportRemoved(proj, id, hint, extra)
	return 0, nil
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
// happened -- and leave the line that did move behind, inviting a
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
// base branch out. Failures never abort the command -- the merge and
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
