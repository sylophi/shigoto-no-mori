package main

// sm land: the finish line as one command -- merge the worktree's PR
// (the sm merge flow), fast-forward the primary checkout so it sees
// the merge, and clean up: the sm rm pipeline for a managed or
// external worktree, or the sm done switch-and-delete when landing
// the primary checkout itself. A PR that's already merged skips
// straight to cleanup, so re-running after a partial failure (say a
// teardown script) resumes where it left off.

import (
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
		reportDone(w, id.Branch, deleted, map[string]any{"merged": mergedDoc})
		return 0, nil
	}

	caughtUp, catchUpDetail := catchUpPrimary(proj)
	if !jsonMode {
		if caughtUp {
			note(dimErr(fmt.Sprintf("primary checkout caught up (%s)", catchUpDetail)))
		} else if catchUpDetail != "" {
			note(dimErr("skipped primary catch-up: " + catchUpDetail))
		}
	}

	hint, err := execRemove(proj, id, opts)
	if err != nil {
		// The merge already happened; a JSON error document that omitted
		// it would read as "nothing changed" to the app or an agent.
		if jsonMode {
			doc := map[string]any{"ok": false, "merged": mergedDoc}
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

	extra := map[string]any{"merged": mergedDoc, "primaryCaughtUp": caughtUp}
	if !caughtUp && catchUpDetail != "" {
		extra["primaryCatchUpSkipped"] = catchUpDetail
	}
	reportRemoved(proj, id, hint, extra)
	return 0, nil
}

// Best-effort fast-forward of the primary checkout after the merge,
// so the local primary branch sees what just landed. Skipped when the
// primary checkout isn't sitting on the primary branch or the primary
// ref has no remote; failures never abort the command -- the merge
// and the cleanup are the substance of land. detail is the pulled ref
// on success and the skip reason otherwise; the caller renders it per
// surface.
func catchUpPrimary(proj project) (caughtUp bool, detail string) {
	pt, err := resolvePrimaryTarget(proj)
	if err != nil {
		return false, err.Error()
	}
	loc, err := primaryOf(proj)
	if err != nil {
		return false, err.Error()
	}
	if loc.worktree.Branch != pt.localPrimary {
		return false, fmt.Sprintf("primary checkout is on %s, not %s", loc.worktree.Branch, pt.localPrimary)
	}
	pulled, err := ffPullPrimary(loc.worktree.Path, pt.primaryRef, pt.remotes)
	if err != nil {
		return false, err.Error()
	}
	if !pulled {
		return false, "primary ref " + pt.primaryRef + " has no remote"
	}
	return true, pt.primaryRef
}
