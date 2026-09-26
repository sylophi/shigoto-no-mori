package main

// sm merge: merge the worktree's pull request the way the app does
// (host/lib/githubCli/): find the PR for the branch via gh's
// server-side --head filter, resolve the merge method from the repo's
// GitHub settings (merge > squash > rebase order, with the project's
// saved lastMergeMethod winning while still allowed), run
// `gh pr merge`, and persist the method used so both surfaces default
// to it next time. --method overrides the resolution explicitly.
//
// --stack merges the PR together with every open PR under it in its
// stack, bottom first (stack.go).
//
// Local cleanup (landing the checkout back on primary, removing the
// worktree) stays separate: `sm done` / `sm rm`.

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

var mergeMethodOrder = []string{"merge", "squash", "rebase"}

func ghAvailable() bool {
	_, err := exec.LookPath("gh")
	return err == nil
}

func runGh(cwd string, args ...string) (string, error) {
	return runGhContext(context.Background(), cwd, args...)
}

// The one gh invocation, so every caller shares the install guard, the
// stderr shaping, and the trace line. The context lets a caller that
// must not hang, like the status card, put a deadline on it.
func runGhContext(ctx context.Context, cwd string, args ...string) (string, error) {
	if !ghAvailable() {
		return "", errf("GitHub CLI isn't installed")
	}
	cmd := exec.CommandContext(ctx, "gh", args...)
	// Without this, a cancelled context kills gh but Wait still blocks
	// on the inherited pipes until every grandchild it spawned (git, a
	// credential helper) exits too, so the caller's deadline isn't one.
	// Only ever reached after the context is already done.
	cmd.WaitDelay = time.Second
	cmd.Dir = cwd
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	vlog("[gh] %s", strings.Join(args, " "))
	if err != nil {
		msg := cmp.Or(strings.TrimSpace(stderr.String()), err.Error())
		return stdout.String(), errf("%s", msg)
	}
	return stdout.String(), nil
}

type prSummary struct {
	Number  int    `json:"number"`
	Title   string `json:"title"`
	State   string `json:"state"`
	IsDraft bool   `json:"isDraft"`
	URL     string `json:"url"`
	// The branch the PR merges into, which is not always the repo's
	// default. land needs it to tell whether the primary branch is even
	// a party to the merge, and a stack is read off it (stack.go).
	BaseRefName string `json:"baseRefName"`
	HeadRefName string `json:"headRefName"`
}

// The gh projection prSummary decodes.
const prSummaryFields = "number,title,state,isDraft,url,baseRefName,headRefName"

// How a branch's PR is located: gh's server-side --head filter, any
// state, newest first. Shared so `merge` and `status` can never end up
// looking at different pull requests. extraFields is for callers that
// need more than prSummary carries.
func prLookupArgs(branch string, extraFields ...string) []string {
	fields := prSummaryFields
	for _, field := range extraFields {
		fields += "," + field
	}
	return []string{"pr", "list", "--state", "all", "--head", branch, "--limit", "1", "--json", fields}
}

// One `gh pr list` call decoded into prSummary rows, for every
// projection built on prSummaryFields.
func ghPrList(projectPath string, args ...string) ([]prSummary, error) {
	stdout, err := runGh(projectPath, args...)
	if err != nil {
		return nil, err
	}
	var prs []prSummary
	if err := json.Unmarshal([]byte(stdout), &prs); err != nil {
		return nil, errf("unexpected gh pr list output: %s", err)
	}
	return prs, nil
}

func findPullRequest(projectPath, branch string) (*prSummary, error) {
	prs, err := ghPrList(projectPath, prLookupArgs(branch)...)
	if err != nil || len(prs) == 0 {
		return nil, err
	}
	return &prs[0], nil
}

// Allowed methods from the repo's GitHub settings; a failed read means
// "assume everything's allowed" so the user isn't blocked by missing
// data (resolveMergeMethod parity).
func allowedMergeMethods(projectPath string) []string {
	stdout, err := runGh(projectPath,
		"repo", "view", "--json",
		"mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed")
	if err != nil {
		return mergeMethodOrder
	}
	var parsed struct {
		MergeCommitAllowed bool `json:"mergeCommitAllowed"`
		SquashMergeAllowed bool `json:"squashMergeAllowed"`
		RebaseMergeAllowed bool `json:"rebaseMergeAllowed"`
	}
	if json.Unmarshal([]byte(stdout), &parsed) != nil {
		return mergeMethodOrder
	}
	byMethod := map[string]bool{
		"merge":  parsed.MergeCommitAllowed,
		"squash": parsed.SquashMergeAllowed,
		"rebase": parsed.RebaseMergeAllowed,
	}
	var allowed []string
	for _, method := range mergeMethodOrder {
		if byMethod[method] {
			allowed = append(allowed, method)
		}
	}
	return allowed
}

// The PR lookup and the repo-settings read are independent gh
// round-trips (300-800ms each), so overlap them. Shared by merge and
// land. pr is nil when the branch has no PR at all.
func resolveMergeTarget(projectPath, branch string) (pr *prSummary, allowed []string, err error) {
	var wg sync.WaitGroup
	wg.Go(func() { pr, err = findPullRequest(projectPath, branch) })
	wg.Go(func() { allowed = allowedMergeMethods(projectPath) })
	wg.Wait()
	return pr, allowed, err
}

// The validated -m/--method flag value, shared by merge and land.
func mergeMethodOf(parsed parsedArgs) (string, error) {
	m := parsed.strings["method"]
	if m != "" && !slices.Contains(mergeMethodOrder, m) {
		return "", usageErrf("Invalid --method %q (merge, squash, or rebase).", m)
	}
	return m, nil
}

// The merge result's JSON fields for merge's document and land's
// nested "merged" object, so the key set can't drift. method == ""
// means the PR was already merged before the command ran.
func mergeResultFields(pr *prSummary, branch, method string) map[string]any {
	doc := map[string]any{
		"number": pr.Number, "title": pr.Title, "branch": branch, "url": pr.URL,
	}
	if method != "" {
		doc["method"] = method
	} else {
		doc["alreadyMerged"] = true
	}
	return doc
}

func cmdMerge(ctx cliContext, args []string) (int, error) {
	spec := worktreeTargetSpec()
	spec.strings["method"] = []string{"m"}
	// App plumbing: merge this PR number directly, skipping the
	// branch -> PR lookup (the app already resolved it).
	spec.strings["number"] = nil
	spec.bools["stack"] = []string{}
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	methodFlag, err := mergeMethodOf(parsed)
	if err != nil {
		return exitCodeOf(err), err
	}
	stack := parsed.bools["stack"]

	if numberFlag := parsed.strings["number"]; numberFlag != "" {
		number, err := strconv.Atoi(numberFlag)
		if err != nil || number <= 0 {
			return 2, usageErrf("Invalid --number %q.", numberFlag)
		}
		proj, err := resolveProjectArgs(ctx, parsed)
		if err != nil {
			return exitCodeOf(err), err
		}
		if stack {
			// nil: the stack lookups fetch the allowed methods alongside.
			return cmdMergeStack(proj, number, methodFlag, nil)
		}
		method, err := execMerge(proj, number, methodFlag, allowedMergeMethods(proj.Path))
		if err != nil {
			return exitCodeOf(err), err
		}
		emitOrOut(map[string]any{"ok": true, "number": number, "method": method},
			greenOut(fmt.Sprintf("merged PR #%d (%s)", number, method)))
		return 0, nil
	}

	target, err := resolveWorktreeArgs(ctx, parsed, true)
	if err != nil {
		return exitCodeOf(err), err
	}
	proj, id := target.proj, target.worktree
	if id.Branch == unknownBranch || id.Detached {
		return 1, errf("No branch checked out to merge")
	}

	pr, allowed, err := resolveMergeTarget(proj.Path, id.Branch)
	if err != nil {
		return 1, err
	}
	if pr == nil {
		return 1, errf("No pull request found for branch %s", id.Branch)
	}
	if pr.State != "OPEN" {
		return 1, errf("PR #%d for %s is %s, not open", pr.Number, id.Branch, strings.ToLower(pr.State))
	}
	if stack {
		return cmdMergeStack(proj, pr.Number, methodFlag, allowed)
	}

	method, err := execMerge(proj, pr.Number, methodFlag, allowed)
	if err != nil {
		return exitCodeOf(err), err
	}

	if jsonMode {
		doc := mergeResultFields(pr, id.Branch, method)
		doc["ok"] = true
		emit(doc)
	} else {
		out(greenOut(fmt.Sprintf("merged PR #%d (%s): %s", pr.Number, method, pr.Title)))
		note(dimErr(fmt.Sprintf("next: `%s done` (primary checkout) or `%s rm %s` (managed worktree)",
			binaryName, binaryName, id.Name)))
	}
	return 0, nil
}

// Resolve the merge method (explicit flag > saved preference > first
// allowed), run `gh pr merge`, and persist the pick. Shared by the
// branch-lookup path and the app's --number path. Callers pass the
// repo's allowed methods so the settings read can overlap other work.
func execMerge(proj project, number int, methodFlag string, allowed []string) (string, error) {
	method, err := resolveMergeMethod(proj, methodFlag, allowed)
	if err != nil {
		return "", err
	}
	if _, err := runGh(proj.Path, "pr", "merge", fmt.Sprint(number), "--"+method); err != nil {
		if err := mergeStackedAlone(proj.Path, number, method, err); err != nil {
			return "", err
		}
	}
	persistMergeMethod(proj, method)
	return method, nil
}

// A PR in a stack GitHub knows refuses the plain merge: only its
// asynchronous merge API lands those, and it lands every open PR
// under the asked one too. So the plain merge of a stacked PR is
// honoured only for the lowest open PR of its stack, where it is that
// PR alone. Anything else is a stack merge, which `merge --stack` and
// the app's stack merge say explicitly. Any other failure is reported
// as it came: the refusal's wording is the cheap gate, the stacks API
// the answer, so a merge that failed for any other reason pays no
// extra round trip.
func mergeStackedAlone(projectPath string, number int, method string, mergeErr error) error {
	if !strings.Contains(mergeErr.Error(), "part of a stack") {
		return mergeErr
	}
	ghStack, err := githubStackFor(projectPath, number)
	if err != nil || ghStack == nil {
		return mergeErr
	}
	if lowest, ok := ghStack.lowestOpen(); !ok || lowest != number {
		return errf("PR #%d sits above open pull requests in its GitHub stack; merge the stack instead (`%s merge --stack`)", number, binaryName)
	}
	return mergeStackAsync(projectPath, number, method)
}

func resolveMergeMethod(proj project, methodFlag string, allowed []string) (string, error) {
	if len(allowed) == 0 {
		return "", errf("The repo's settings allow no merge method")
	}
	if methodFlag != "" {
		if !slices.Contains(allowed, methodFlag) {
			return "", errf("The repo's settings don't allow %s merges (allowed: %s)",
				methodFlag, strings.Join(allowed, ", "))
		}
		return methodFlag, nil
	}
	method := allowed[0]
	config := readProjectConfig(proj.ID)
	if config != nil && slices.Contains(allowed, config.LastMergeMethod) {
		method = config.LastMergeMethod
	}
	return method, nil
}

// Best-effort preference persist, same as the app. The config engine's
// lock and backfill hooks apply.
func persistMergeMethod(proj project, method string) {
	err := projectConfigScope(proj).update(func(doc map[string]any) error {
		configDocSet(doc, "lastMergeMethod", method)
		return nil
	})
	if err != nil {
		vlog("[merge] persist lastMergeMethod: %v", err)
	}
}

// The --stack arm of both paths: every open PR from the bottom of the
// stack up to and including `number`, one JSON event per landed PR in
// --json mode so a caller can follow along. `allowed` is the repo's
// merge methods when the caller already fetched them, else nil and
// the stack lookups fetch them alongside their own round trips.
func cmdMergeStack(proj project, number int, methodFlag string, allowed []string) (int, error) {
	lk, err := lookupStack(proj, number, allowed)
	if err != nil {
		return exitCodeOf(err), err
	}
	method, err := resolveMergeMethod(proj, methodFlag, lk.allowed)
	if err != nil {
		return exitCodeOf(err), err
	}
	if err := execMergeStack(proj, number, method, lk, stackMergedReporter(method)); err != nil {
		return exitCodeOf(err), err
	}
	persistMergeMethod(proj, method)
	if jsonMode {
		emit(map[string]any{"ok": true, "method": method})
	}
	return 0, nil
}
