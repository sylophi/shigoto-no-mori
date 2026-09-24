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
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
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

func findPullRequest(projectPath, branch string) (*prSummary, error) {
	stdout, err := runGh(projectPath, prLookupArgs(branch)...)
	if err != nil {
		return nil, err
	}
	var prs []prSummary
	if err := json.Unmarshal([]byte(stdout), &prs); err != nil {
		return nil, errf("unexpected gh pr list output: %s", err)
	}
	if len(prs) == 0 {
		return nil, nil
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
	wg.Add(2)
	go func() { defer wg.Done(); pr, err = findPullRequest(projectPath, branch) }()
	go func() { defer wg.Done(); allowed = allowedMergeMethods(projectPath) }()
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
			return cmdMergeStack(proj, number, methodFlag)
		}
		method, err := execMerge(proj, number, methodFlag, allowedMergeMethods(proj.Path))
		if err != nil {
			return exitCodeOf(err), err
		}
		if jsonMode {
			emit(map[string]any{"ok": true, "number": number, "method": method})
		} else {
			out(greenOut(fmt.Sprintf("merged PR #%d (%s)", number, method)))
		}
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
		return cmdMergeStack(proj, pr.Number, methodFlag)
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
		// A PR in a stack GitHub knows refuses the plain merge and
		// names the asynchronous merge API. That API merges the PR
		// together with whatever is still open under it, which is what
		// GitHub means by merging a stacked PR; for the bottom PR, the
		// common case here, it is just that PR.
		if !isStackedMergeRefusal(err) {
			return "", err
		}
		if err := mergeStackAsync(proj.Path, number, method); err != nil {
			return "", err
		}
	}
	persistMergeMethod(proj, method)
	return method, nil
}

func isStackedMergeRefusal(err error) bool {
	return strings.Contains(err.Error(), "part of a stack")
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
// --json mode so a caller can follow along.
func cmdMergeStack(proj project, number int, methodFlag string) (int, error) {
	method, err := resolveMergeMethod(proj, methodFlag, allowedMergeMethods(proj.Path))
	if err != nil {
		return exitCodeOf(err), err
	}
	onMerged := func(pr prSummary) {
		if jsonMode {
			emit(map[string]any{"event": "merged", "number": pr.Number, "branch": pr.HeadRefName, "method": method})
		} else {
			out(greenOut(fmt.Sprintf("merged PR #%d (%s): %s", pr.Number, method, pr.Title)))
		}
	}
	set, err := execMergeStack(proj, number, method, onMerged)
	if err != nil {
		return exitCodeOf(err), err
	}
	persistMergeMethod(proj, method)
	if jsonMode {
		numbers := make([]int, len(set))
		for i, pr := range set {
			numbers[i] = pr.Number
		}
		emit(map[string]any{"ok": true, "numbers": numbers, "method": method})
	}
	return 0, nil
}
