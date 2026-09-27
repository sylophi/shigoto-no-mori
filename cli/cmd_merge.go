package main

// sm merge: merge the worktree's pull request the way the app does
// (host/lib/githubCli/): find the PR for the branch via gh's
// server-side --head filter, resolve the merge method from the repo's
// GitHub settings (merge > squash > rebase order, with the project's
// saved lastMergeMethod winning while still allowed), run
// `gh pr merge`, and persist the method used so both surfaces default
// to it next time. --method overrides the resolution explicitly.
//
// On a repo that allows auto-merge, a PR that is waiting on its base
// branch's rules (checks still running, a review missing) isn't
// refused: auto-merge is armed instead, and GitHub merges it the
// moment the rules are met. A PR that can merge now merges now.
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
	// GitHub's merge verdict (CLEAN, BLOCKED, BEHIND, DIRTY, ...) and
	// the auto-merge armed on the PR, if any: what the merge reads to
	// pick between merging now and arming auto-merge. Only the
	// single-PR lookups ask for them (mergeFields). A row of the
	// page-wide listing (stack.go) leaves them empty.
	MergeStateStatus string            `json:"mergeStateStatus,omitempty"`
	AutoMergeRequest *autoMergeRequest `json:"autoMergeRequest,omitempty"`
}

// GitHub's record of an armed auto-merge: the method it will merge
// with, as GraphQL spells it (MERGE, SQUASH, REBASE).
type autoMergeRequest struct {
	MergeMethod string `json:"mergeMethod"`
}

// The method in gh's spelling (merge, squash, rebase).
func (r *autoMergeRequest) method() string { return strings.ToLower(r.MergeMethod) }

// The gh projection prSummary decodes.
const prSummaryFields = "number,title,state,isDraft,url,baseRefName,headRefName"

// The fields a merge decides on. GitHub computes the verdict per PR,
// so only the merge paths ask for them (mergeLookupArgs). sm pr, the
// stack walks and the catch-up lookups keep the cheap projection.
const mergeFields = "mergeStateStatus,autoMergeRequest"

// How a branch's PR is located: gh's server-side --head filter, any
// state, newest first. Shared so `merge` and `status` can never end up
// looking at different pull requests. extraFields is for callers that
// need more than prSummary carries.
func prLookupArgs(branch string, extraFields ...string) []string {
	return []string{"pr", "list", "--state", "all", "--head", branch, "--limit", "1", "--json", prFields(extraFields...)}
}

func mergeLookupArgs(branch string) []string {
	return prLookupArgs(branch, mergeFields)
}

// The --json projection: the summary, plus what the caller adds.
func prFields(extraFields ...string) string {
	fields := prSummaryFields
	for _, field := range extraFields {
		fields += "," + field
	}
	return fields
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

// One PR by number, any state, or nil when the repo has none.
func findPullRequestByNumber(projectPath string, number int, extraFields ...string) (*prSummary, error) {
	stdout, err := runGh(projectPath, "pr", "view", fmt.Sprint(number), "--json", prFields(extraFields...))
	if err != nil {
		if strings.Contains(err.Error(), "Could not resolve") || strings.Contains(err.Error(), "no pull requests found") {
			return nil, nil
		}
		return nil, err
	}
	var pr prSummary
	if err := json.Unmarshal([]byte(stdout), &pr); err != nil {
		return nil, errf("unexpected gh pr view output: %s", err)
	}
	return &pr, nil
}

func findPullRequest(projectPath, branch string) (*prSummary, error) {
	return findPullRequestWith(projectPath, prLookupArgs(branch))
}

func findPullRequestWith(projectPath string, args []string) (*prSummary, error) {
	prs, err := ghPrList(projectPath, args...)
	if err != nil || len(prs) == 0 {
		return nil, err
	}
	return &prs[0], nil
}

// The repo's merge settings on GitHub: the methods its merge button
// offers, in mergeMethodOrder, and whether auto-merge may be armed on
// its PRs. A failed read means "every method, no auto-merge": the
// user isn't blocked by missing data (resolveMergeMethod parity), and
// gh's --auto is only asked for where GitHub is known to accept it.
type repoMergeSettings struct {
	allowed   []string
	autoMerge bool
}

// One GraphQL read, since `gh repo view --json` has the three method
// flags but not autoMergeAllowed. On one line so the call logs as one.
const repoMergeQuery = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) " +
	"{ mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed } }"

func readRepoMergeSettings(projectPath string) repoMergeSettings {
	everything := repoMergeSettings{allowed: mergeMethodOrder}
	// gh fills {owner} and {repo} from the repo's remote in field
	// values the way it does in REST paths.
	stdout, err := runGh(projectPath, "api", "graphql",
		"-F", "owner={owner}", "-F", "name={repo}", "-f", "query="+repoMergeQuery)
	if err != nil {
		return everything
	}
	var parsed struct {
		Data struct {
			Repository struct {
				MergeCommitAllowed bool `json:"mergeCommitAllowed"`
				SquashMergeAllowed bool `json:"squashMergeAllowed"`
				RebaseMergeAllowed bool `json:"rebaseMergeAllowed"`
				AutoMergeAllowed   bool `json:"autoMergeAllowed"`
			} `json:"repository"`
		} `json:"data"`
	}
	if json.Unmarshal([]byte(stdout), &parsed) != nil {
		return everything
	}
	repo := parsed.Data.Repository
	byMethod := map[string]bool{
		"merge":  repo.MergeCommitAllowed,
		"squash": repo.SquashMergeAllowed,
		"rebase": repo.RebaseMergeAllowed,
	}
	var allowed []string
	for _, method := range mergeMethodOrder {
		if byMethod[method] {
			allowed = append(allowed, method)
		}
	}
	return repoMergeSettings{allowed: allowed, autoMerge: repo.AutoMergeAllowed}
}

// The repo's merge methods alone, for the stack paths, which never
// arm auto-merge.
func allowedMergeMethods(projectPath string) []string {
	return readRepoMergeSettings(projectPath).allowed
}

// The PR lookup and the repo-settings read are independent gh
// round-trips (300-800ms each), so overlap them. Shared by merge and
// land. pr is nil when the branch has no PR at all.
func resolveMergeTarget(projectPath, branch string) (*prSummary, repoMergeSettings, error) {
	return lookupMergeTarget(projectPath, func() (*prSummary, error) {
		return findPullRequestWith(projectPath, mergeLookupArgs(branch))
	})
}

// find is the PR lookup, with mergeFields in its projection.
func lookupMergeTarget(projectPath string, find func() (*prSummary, error)) (pr *prSummary, settings repoMergeSettings, err error) {
	var wg sync.WaitGroup
	wg.Go(func() { pr, err = find() })
	wg.Go(func() { settings = readRepoMergeSettings(projectPath) })
	wg.Wait()
	return pr, settings, err
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

// How a merge ended, in the app's spelling (MergeOutcomeSchema,
// shared/schemas/pullRequest.ts). The PR landed, or a merge queue took
// it (a GitHub stack's, or a base branch with a queue), or auto-merge
// is armed and GitHub lands it once its requirements are met. The last
// two leave the PR open, which land reads as "nothing to clean up yet".
const (
	outcomeMerged    = "merged"
	outcomeQueued    = "queued"
	outcomeAutoMerge = "auto-merge"
)

type mergeOutcome struct {
	method  string
	outcome string
}

func (o mergeOutcome) pending() bool { return o.outcome != outcomeMerged }

// The JSON fields the outcome adds to merge's and land's documents.
// queued predates outcome and stays for readers of the old shape.
func (o mergeOutcome) addTo(doc map[string]any) {
	doc["outcome"] = o.outcome
	doc["queued"] = o.outcome == outcomeQueued
}

// The green line: what became of the PR.
func (o mergeOutcome) line(pr *prSummary) string {
	verb := "merged"
	switch o.outcome {
	case outcomeQueued:
		verb = "queued"
	case outcomeAutoMerge:
		verb = "auto-merge enabled for"
	}
	return greenOut(fmt.Sprintf("%s PR #%d (%s): %s", verb, pr.Number, o.method, pr.Title))
}

// What to run next: the cleanup, once the PR has landed.
func mergeNextHint(o mergeOutcome, id worktreeIdentity) string {
	cleanup := fmt.Sprintf("`%s done` (primary checkout) or `%s rm %s` (managed worktree)",
		binaryName, binaryName, id.Name)
	switch o.outcome {
	case outcomeAutoMerge:
		return "GitHub merges it once its requirements are met; then " + cleanup
	case outcomeQueued:
		return "the merge queue lands it; then " + cleanup
	}
	return "next: " + cleanup
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
		pr, settings, err := lookupMergeTarget(proj.Path, func() (*prSummary, error) {
			return findPullRequestByNumber(proj.Path, number, mergeFields)
		})
		if err != nil {
			return 1, err
		}
		if pr == nil {
			return 1, errf("No pull request #%d", number)
		}
		if pr.State != "OPEN" {
			return 1, errf("PR #%d is %s, not open", number, strings.ToLower(pr.State))
		}
		o, err := execMerge(proj, pr, methodFlag, settings)
		if err != nil {
			return exitCodeOf(err), err
		}
		doc := map[string]any{"ok": true, "number": number, "method": o.method}
		o.addTo(doc)
		emitOrOut(doc, o.line(pr))
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

	pr, settings, err := resolveMergeTarget(proj.Path, id.Branch)
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
		return cmdMergeStack(proj, pr.Number, methodFlag, settings.allowed)
	}

	o, err := execMerge(proj, pr, methodFlag, settings)
	if err != nil {
		return exitCodeOf(err), err
	}

	if jsonMode {
		doc := mergeResultFields(pr, id.Branch, o.method)
		doc["ok"] = true
		o.addTo(doc)
		emit(doc)
	} else {
		out(o.line(pr))
		note(dimErr(mergeNextHint(o, id)))
	}
	return 0, nil
}

// Resolve the merge method (explicit flag > saved preference > first
// allowed), land the PR the way its verdict allows, and persist the
// pick. Shared by the branch-lookup path, the app's --number path and
// land. Callers pass the repo's settings so that read can overlap the
// PR lookup. On a repo that allows auto-merge, a PR waiting on its
// base branch's rules gets auto-merge armed instead of a refusal.
// Everything else is `gh pr merge` now.
func execMerge(proj project, pr *prSummary, methodFlag string, settings repoMergeSettings) (mergeOutcome, error) {
	method, err := resolveMergeMethod(proj, methodFlag, settings.allowed)
	if err != nil {
		return mergeOutcome{}, err
	}
	var o mergeOutcome
	if settings.autoMerge && autoMergeArms(pr.MergeStateStatus) {
		o, err = armAutoMerge(proj.Path, pr, method)
	} else {
		o, err = mergeNow(proj.Path, pr.Number, method)
	}
	if err != nil {
		return mergeOutcome{}, err
	}
	persistMergeMethod(proj, method)
	return o, nil
}

// `gh pr merge`, with the stacked-PR fallback below.
func mergeNow(projectPath string, number int, method string) (mergeOutcome, error) {
	o := mergeOutcome{method: method, outcome: outcomeMerged}
	if _, err := runGh(projectPath, "pr", "merge", fmt.Sprint(number), "--"+method); err != nil {
		queued, err := mergeStackedAlone(projectPath, number, method, err)
		if err != nil {
			return mergeOutcome{}, err
		}
		if queued {
			o.outcome = outcomeQueued
		}
	}
	return o, nil
}

// The verdicts auto-merge is for: the base branch's rules aren't met
// yet (checks running, a review missing), or the head must catch up
// with a base that requires it up to date. A verdict that allows the
// merge merges now (gh's own --auto does the same), and a conflict
// (DIRTY) or a verdict GitHub hasn't computed keeps the plain merge's
// refusal, which names the reason, since waiting wouldn't fix either. The
// app's merge button reads the same verdicts (renderer/lib/pullRequest.ts).
func autoMergeArms(mergeStateStatus string) bool {
	return mergeStateStatus == "BLOCKED" || mergeStateStatus == "BEHIND"
}

// Arm auto-merge on the PR, so GitHub merges it once its requirements
// are met. gh's --auto merges at once instead when the verdict has
// moved since the lookup, and a base branch with a merge queue queues
// the PR, so the outcome is read back off the PR rather than assumed.
func armAutoMerge(projectPath string, pr *prSummary, method string) (mergeOutcome, error) {
	if armed := pr.AutoMergeRequest; armed != nil {
		// GitHub refuses a second enable, and the PR lands on its
		// own with what is armed.
		note(dimErr(fmt.Sprintf("auto-merge was already enabled for PR #%d", pr.Number)))
		return mergeOutcome{method: cmp.Or(armed.method(), method), outcome: outcomeAutoMerge}, nil
	}
	if _, err := runGh(projectPath, "pr", "merge", fmt.Sprint(pr.Number), "--auto", "--"+method); err != nil {
		return mergeOutcome{}, err
	}
	return autoMergeOutcome(projectPath, pr.Number, method)
}

// GraphQL, since `gh pr view --json` doesn't expose isInMergeQueue.
// The number goes first so a test's fake gh can tell this query from
// the repo settings' by its prefix.
const autoMergeOutcomeQuery = "query($number: Int!, $owner: String!, $name: String!) { repository(owner: $owner, name: $name) " +
	"{ pullRequest(number: $number) { state isInMergeQueue autoMergeRequest { mergeMethod } } } }"

func autoMergeOutcome(projectPath string, number int, method string) (mergeOutcome, error) {
	armed := mergeOutcome{method: method, outcome: outcomeAutoMerge}
	stdout, err := runGh(projectPath, "api", "graphql", "-F", "number="+fmt.Sprint(number),
		"-F", "owner={owner}", "-F", "name={repo}", "-f", "query="+autoMergeOutcomeQuery)
	if err != nil {
		// gh accepted the merge. This read only shapes the report.
		return armed, nil
	}
	var parsed struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					State            string            `json:"state"`
					IsInMergeQueue   bool              `json:"isInMergeQueue"`
					AutoMergeRequest *autoMergeRequest `json:"autoMergeRequest"`
				} `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
	}
	if json.Unmarshal([]byte(stdout), &parsed) != nil {
		return armed, nil
	}
	after := parsed.Data.Repository.PullRequest
	switch {
	case after.State == "MERGED":
		return mergeOutcome{method: method, outcome: outcomeMerged}, nil
	case after.IsInMergeQueue:
		return mergeOutcome{method: method, outcome: outcomeQueued}, nil
	}
	return armed, nil
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
func mergeStackedAlone(projectPath string, number int, method string, mergeErr error) (queued bool, err error) {
	if !strings.Contains(mergeErr.Error(), "part of a stack") {
		return false, mergeErr
	}
	ghStack, err := githubStackFor(projectPath, number)
	if err != nil || ghStack == nil {
		return false, mergeErr
	}
	if lowest, ok := ghStack.lowestOpen(); !ok || lowest != number {
		return false, errf("PR #%d sits above open pull requests in its GitHub stack. Merge the stack instead (`%s merge --stack` or `%s land --stack`)", number, binaryName, binaryName)
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
	lk, err := lookupStack(proj, number, allowed, true)
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
