package main

// sm merge: merge the worktree's pull request the way the app does
// (main/lib/githubCli/): find the PR for the branch via gh's
// server-side --head filter, resolve the merge method from the repo's
// GitHub settings (merge > squash > rebase order, with the project's
// saved lastMergeMethod winning while still allowed), run
// `gh pr merge`, and persist the method used so both surfaces default
// to it next time. --method overrides the resolution explicitly.
//
// Local cleanup (landing the checkout back on primary, removing the
// worktree) stays separate: `sm done` / `sm rm`.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
)

var mergeMethodOrder = []string{"merge", "squash", "rebase"}

func runGh(cwd string, args ...string) (string, error) {
	if _, err := exec.LookPath("gh"); err != nil {
		return "", errf("GitHub CLI isn't installed")
	}
	cmd := exec.Command("gh", args...)
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
}

func findPullRequest(projectPath, branch string) (*prSummary, error) {
	stdout, err := runGh(projectPath,
		"pr", "list", "--state", "all", "--head", branch, "--limit", "1",
		"--json", "number,title,state,isDraft,url")
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
// round-trips (300-800ms each); overlap them -- shared by merge and
// land. pr is nil when the branch has no PR at all.
func resolveMergeTarget(projectPath, branch string) (pr *prSummary, allowed []string, err error) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); pr, err = findPullRequest(projectPath, branch) }()
	go func() { defer wg.Done(); allowed = allowedMergeMethods(projectPath) }()
	wg.Wait()
	return pr, allowed, err
}

// The validated -m/--method flag value -- shared by merge and land.
func mergeMethodOf(parsed parsedArgs) (string, error) {
	m := parsed.strings["method"]
	if m != "" && !slices.Contains(mergeMethodOrder, m) {
		return "", usageErrf("Invalid --method %q (merge, squash, or rebase).", m)
	}
	return m, nil
}

// The merge result's JSON fields -- merge's document and land's
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
	parsed, err := parseCmdArgs(args, spec)
	if err != nil {
		return exitCodeOf(err), err
	}
	methodFlag, err := mergeMethodOf(parsed)
	if err != nil {
		return exitCodeOf(err), err
	}

	if numberFlag := parsed.strings["number"]; numberFlag != "" {
		number, err := strconv.Atoi(numberFlag)
		if err != nil || number <= 0 {
			return 2, usageErrf("Invalid --number %q.", numberFlag)
		}
		proj, err := resolveProjectArgs(ctx, parsed)
		if err != nil {
			return exitCodeOf(err), err
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
// allowed), run `gh pr merge`, and persist the pick -- shared by the
// branch-lookup path and the app's --number path. Callers pass the
// repo's allowed methods so the settings read can overlap other work.
func execMerge(proj project, number int, methodFlag string, allowed []string) (string, error) {
	if len(allowed) == 0 {
		return "", errf("The repo's settings allow no merge method")
	}
	method := methodFlag
	if method != "" {
		if !slices.Contains(allowed, method) {
			return "", errf("The repo's settings don't allow %s merges (allowed: %s)",
				method, strings.Join(allowed, ", "))
		}
	} else {
		method = allowed[0]
		config := readProjectConfig(proj.ID)
		if config != nil && slices.Contains(allowed, config.LastMergeMethod) {
			method = config.LastMergeMethod
		}
	}

	if _, err := runGh(proj.Path, "pr", "merge", fmt.Sprint(number), "--"+method); err != nil {
		return "", err
	}

	// Best-effort preference persist, same as the app.
	if err := writeProjectConfigFields(proj.ID, map[string]any{"lastMergeMethod": method}); err != nil {
		vlog("[merge] persist lastMergeMethod: %v", err)
	}
	return method, nil
}
