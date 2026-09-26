package main

// Stacked pull requests for `sm merge --stack`: the PR and every PR
// under it, found the way the app finds them (shared/pullRequestStack.ts):
// a PR whose base is another PR's head is stacked on it. The trunk (the
// project's primary branch) is never a member, so a long-lived
// "main -> production" PR doesn't make every PR look stacked.
//
// Two ways to land a stack, picked by asking GitHub:
//   - A stack GitHub knows (`gh stack`, or linked on github.com) can
//     only be merged through its asynchronous merge API, which lands
//     every PR up to the asked one in one all-or-nothing operation.
//   - Any other chain is merged one PR at a time from the bottom, each
//     next PR retargeted at the trunk first, since GitHub only does
//     that retarget itself when the landed branch is deleted.

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

// Every PR of the repo, newest first, the sidebar sweep's projection
// plus the two refs a stack is read from. Same page size as the sweep
// (PR_LIST_LIMIT in host/lib/githubCli/pullRequests.ts).
func listPullRequests(projectPath string) ([]prSummary, error) {
	return ghPrList(projectPath, "pr", "list", "--state", "all",
		"--limit", "200", "--json", prSummaryFields)
}

// Bounds the walk down a chain, like MAX_DEPTH in
// shared/pullRequestStack.ts: the rows are a snapshot, so a loop in
// stale ones must end.
const maxStackDepth = 64

// The chain from the bottom of the stack up to and including `number`,
// or just that PR when nothing sits under it. Newest PR wins a reused
// head branch, like the app's map. Any state along the way: a stack
// whose bottom already landed, with the next PR still based on the
// landed branch, is still that stack, and the trunk is still the
// bottom PR's base.
func stackBelow(prs []prSummary, number int, trunk string) []prSummary {
	byHead := map[string]prSummary{}
	var own *prSummary
	for i := range prs {
		pr := prs[i]
		if _, seen := byHead[pr.HeadRefName]; !seen {
			byHead[pr.HeadRefName] = pr
		}
		if pr.Number == number && own == nil {
			own = &prs[i]
		}
	}
	if own == nil {
		return nil
	}
	chain := []prSummary{*own}
	visited := map[string]bool{own.HeadRefName: true}
	cursor := *own
	for len(chain) < maxStackDepth {
		parent, ok := byHead[cursor.BaseRefName]
		if !ok || cursor.BaseRefName == trunk || visited[parent.HeadRefName] {
			break
		}
		visited[parent.HeadRefName] = true
		chain = append(chain, parent)
		cursor = parent
	}
	slices.Reverse(chain)
	return chain
}

// The PRs a stack merge lands, bottom first: the open ones. A closed
// PR under an open one breaks the stack (its changes would ride up
// with the PR above it), and a draft isn't mergeable, so both refuse
// the whole merge before anything lands.
func stackMergeSet(chain []prSummary) ([]prSummary, error) {
	var set []prSummary
	for _, pr := range chain {
		switch pr.State {
		case "CLOSED":
			return nil, errf("PR #%d (%s) under the stack is closed without merging; reopen or rebase past it first", pr.Number, pr.HeadRefName)
		case "OPEN":
			if pr.IsDraft {
				return nil, errf("PR #%d (%s) in the stack is a draft; mark it ready first", pr.Number, pr.HeadRefName)
			}
			set = append(set, pr)
		}
	}
	if len(set) == 0 {
		return nil, errf("Every PR in the stack is already merged")
	}
	return set, nil
}

// GitHub's stack object for a PR, or nil when the PR isn't in one.
// `{owner}/{repo}` are gh's own placeholders, filled from the repo's
// remote.
func githubStackFor(projectPath string, number int) (*githubStack, error) {
	stdout, err := runGh(projectPath, "api",
		fmt.Sprintf("repos/{owner}/{repo}/stacks?pull_request=%d", number))
	if err != nil {
		// A host without the stacks API (GHES, or the feature off)
		// answers 404: not an error, just not a GitHub stack.
		if strings.Contains(err.Error(), "HTTP 404") {
			return nil, nil
		}
		return nil, err
	}
	var stacks []githubStack
	if err := json.Unmarshal([]byte(stdout), &stacks); err != nil {
		return nil, errf("unexpected gh api stacks output: %s", err)
	}
	for i := range stacks {
		if stacks[i].contains(number) {
			return &stacks[i], nil
		}
	}
	return nil, nil
}

// The stack as GitHub lists it, bottom first.
type githubStack struct {
	PullRequests []githubStackEntry `json:"pull_requests"`
}

type githubStackEntry struct {
	Number int `json:"number"`
	// "open" or "closed". A merged PR is closed.
	State string `json:"state"`
}

func (s *githubStack) contains(number int) bool {
	return slices.ContainsFunc(s.PullRequests, func(e githubStackEntry) bool { return e.Number == number })
}

// The stack's lowest PR still open, the one a merge lands alone.
func (s *githubStack) lowestOpen() (int, bool) {
	for _, entry := range s.PullRequests {
		if entry.State == "open" {
			return entry.Number, true
		}
	}
	return 0, false
}

// The asynchronous merge's ticket and outcome, as GitHub reports them.
type asyncMerge struct {
	Status  string `json:"status"`
	Details struct {
		Message string `json:"message"`
		UUID    string `json:"uuid"`
	} `json:"details"`
}

const (
	asyncMergePoll    = 2 * time.Second
	asyncMergeTimeout = 3 * time.Minute
)

// GitHub's own stack merge: every PR of the stack up to and including
// `number` lands on the base branch, or none does. Blocks until GitHub
// reports the outcome. A base branch with a merge queue queues the
// stack instead: not a failure, but not landed either, which the
// queued flag says so a caller that cleans up after the merge waits.
func mergeStackAsync(projectPath string, number int, method string) (queued bool, err error) {
	stdout, err := runGh(projectPath, "api", "-X", "PUT",
		fmt.Sprintf("repos/{owner}/{repo}/pulls/%d/merge-async", number),
		"-f", "merge_method="+method)
	if err != nil {
		return false, err
	}
	var ticket asyncMerge
	if err := json.Unmarshal([]byte(stdout), &ticket); err != nil {
		return false, errf("unexpected merge-async output: %s", err)
	}
	deadline := time.Now().Add(asyncMergeTimeout)
	for ticket.Status == "pending" {
		if time.Now().After(deadline) {
			return false, errf("GitHub is still merging the stack; check PR #%d", number)
		}
		time.Sleep(asyncMergePoll)
		stdout, err = runGh(projectPath, "api",
			fmt.Sprintf("repos/{owner}/{repo}/pulls/%d/merge-async/%s", number, ticket.Details.UUID))
		if err != nil {
			return false, err
		}
		if err := json.Unmarshal([]byte(stdout), &ticket); err != nil {
			return false, errf("unexpected merge-async output: %s", err)
		}
	}
	switch ticket.Status {
	case "merged":
		return false, nil
	case "enqueued":
		note(dimErr("the stack is in the merge queue; it lands when the queue processes it"))
		return true, nil
	}
	return false, errf("GitHub didn't merge the stack: %s", ticket.Details.Message)
}

// One PR at a time from the bottom, for a chain GitHub doesn't know as
// a stack. Each PR above the bottom is retargeted at the trunk first.
// Merging it into its old base (a branch that already landed) would
// merge nothing. Stops at the first failure, reporting what landed.
func mergeStackSequentially(projectPath string, set []prSummary, trunk, method string, onMerged func(prSummary)) error {
	for i, pr := range set {
		if pr.BaseRefName != trunk {
			if _, err := runGh(projectPath, "pr", "edit", fmt.Sprint(pr.Number), "--base", trunk); err != nil {
				return stackStepError(set[:i], pr, err)
			}
			awaitMergeability(projectPath, pr.Number)
		}
		if _, err := runGh(projectPath, "pr", "merge", fmt.Sprint(pr.Number), "--"+method); err != nil {
			return stackStepError(set[:i], pr, err)
		}
		onMerged(pr)
	}
	return nil
}

func stackStepError(landed []prSummary, failed prSummary, err error) error {
	if len(landed) == 0 {
		return errf("PR #%d: %s", failed.Number, err)
	}
	numbers := joinMapped(landed, func(pr prSummary) string { return fmt.Sprintf("#%d", pr.Number) })
	return errf("merged %s, then PR #%d failed: %s", numbers, failed.Number, err)
}

// GitHub recomputes a PR's mergeability after a retarget. Merging in
// that window fails with a bare "not mergeable". Wait for the verdict,
// briefly: the merge itself is the real check.
func awaitMergeability(projectPath string, number int) {
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		stdout, err := runGh(projectPath, "pr", "view", fmt.Sprint(number), "--json", "mergeStateStatus")
		if err != nil {
			return
		}
		var parsed struct {
			MergeStateStatus string `json:"mergeStateStatus"`
		}
		if json.Unmarshal([]byte(stdout), &parsed) == nil && parsed.MergeStateStatus != "UNKNOWN" && parsed.MergeStateStatus != "" {
			return
		}
		time.Sleep(time.Second)
	}
}

// What a stack merge needs to know before it lands anything. Four
// independent round trips (git for the trunk, gh for the repo's merge
// methods, the PR list and the stack object), so they overlap.
type stackLookups struct {
	pt      primaryTarget
	trunk   string
	allowed []string
	prs     []prSummary
	ghStack *githubStack
}

// withGhStack asks GitHub for its stack object too, which only a merge
// needs (a cleanup never reads it, and shouldn't fail on that call).
func lookupStack(proj project, number int, allowed []string, withGhStack bool) (stackLookups, error) {
	var (
		lk    stackLookups
		wg    sync.WaitGroup
		ptErr error
		lsErr error
		stErr error
	)
	lk.allowed = allowed
	wg.Go(func() {
		lk.pt, ptErr = resolvePrimaryTarget(proj)
		lk.trunk = lk.pt.localPrimary
	})
	wg.Go(func() { lk.prs, lsErr = listPullRequests(proj.Path) })
	if withGhStack {
		wg.Go(func() { lk.ghStack, stErr = githubStackFor(proj.Path, number) })
	}
	if allowed == nil {
		wg.Go(func() { lk.allowed = allowedMergeMethods(proj.Path) })
	}
	wg.Wait()
	return lk, errors.Join(ptErr, lsErr, stErr)
}

// One JSON event per landed PR in --json mode, so a caller can follow
// along, and the green line otherwise. Shared by merge and land.
func stackMergedReporter(method string) func(prSummary) {
	return func(pr prSummary) {
		emitOrOut(map[string]any{"event": "merged", "number": pr.Number, "branch": pr.HeadRefName, "method": method},
			greenOut(fmt.Sprintf("merged PR #%d (%s): %s", pr.Number, method, pr.Title)))
	}
}

// The whole `--stack` merge: resolve the set, pick GitHub's own merge
// when it knows the stack, land one PR at a time otherwise. Reports
// each landed PR through onMerged either way.
func execMergeStack(proj project, number int, method string, lk stackLookups, onMerged func(prSummary)) error {
	chain, err := stackChain(proj, number, lk)
	if err != nil {
		return err
	}
	set, err := stackMergeSet(chain)
	if err != nil {
		return err
	}
	_, err = mergeStackSet(proj, number, method, lk, chain, set, onMerged)
	return err
}

// The full chain under `number`, bottom first, ending in that PR: the
// listing's rows, then the layers that fell off the page. A PR older
// than the page itself (a stack that landed long ago, being cleaned
// up) is fetched on its own and the walk starts from it. Shared by
// merge, land and rm --stack, which reads the worktrees to clean up
// off it.
func stackChain(proj project, number int, lk stackLookups) ([]prSummary, error) {
	chain := stackBelow(lk.prs, number, lk.trunk)
	if chain == nil {
		own, err := findPullRequestByNumber(proj.Path, number)
		if err != nil {
			return nil, err
		}
		if own == nil {
			return nil, errf("No pull request #%d", number)
		}
		chain = []prSummary{*own}
	}
	return extendBelow(chain, lk.trunk, func(branch string) (*prSummary, error) {
		return findPullRequest(proj.Path, branch)
	})
}

// Lands a resolved set (stackMergeSet of chain) the way the stack
// allows: GitHub's own merge when it knows the stack, one PR at a time
// otherwise. queued means a merge queue took the stack instead of
// landing it, and onMerged was not called for anything.
func mergeStackSet(proj project, number int, method string, lk stackLookups, chain, set []prSummary, onMerged func(prSummary)) (queued bool, err error) {
	if lk.ghStack != nil {
		queued, err := mergeStackAsync(proj.Path, number, method)
		if err != nil || queued {
			return queued, err
		}
		for _, pr := range set {
			onMerged(pr)
		}
		return false, nil
	}
	return false, mergeStackSequentially(proj.Path, set, chain[0].BaseRefName, method, onMerged)
}

// The listing is one page of the newest PRs, so an old, merged bottom
// can be missing from it, and a chain read off the page alone would
// then land on that bottom's branch instead of the trunk. Walk the
// remaining way down with one lookup per missing layer (gh's
// server-side --head filter, any state), until the base is the trunk
// or has no PR at all.
func extendBelow(chain []prSummary, trunk string, lookup func(branch string) (*prSummary, error)) ([]prSummary, error) {
	for len(chain) < maxStackDepth {
		base := chain[0].BaseRefName
		if base == trunk {
			return chain, nil
		}
		below, err := lookup(base)
		if err != nil {
			return nil, err
		}
		if below == nil {
			return chain, nil
		}
		chain = append([]prSummary{*below}, chain...)
	}
	return chain, nil
}
