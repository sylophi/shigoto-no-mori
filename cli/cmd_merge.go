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
// moment the rules are met. A PR that can merge now merges now. Either
// that or a merge queue taking the PR is waited on until GitHub has
// merged it (awaitMerge), except for the app's --number merge, which
// shows the armed or queued PR itself.
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
	// A PR from a fork's branch, never the branch's own (prLookupArgs).
	IsCrossRepository bool `json:"isCrossRepository,omitempty"`
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
const prSummaryFields = "number,title,state,isDraft,url,baseRefName,headRefName,isCrossRepository"

// The fields a merge decides on. GitHub computes the verdict per PR,
// so only the merge paths ask for them (mergeLookupArgs). sm pr, the
// stack walks and the catch-up lookups keep the cheap projection.
const mergeFields = "mergeStateStatus,autoMergeRequest"

// How a branch's PR is located: gh's server-side --head filter, any
// state, newest first. Shared so `merge` and `status` can never end up
// looking at different pull requests. extraFields is for callers that
// need more than prSummary carries. A few, not one: the filter matches
// the name across every fork, so a stranger's fork PR of the same name
// may be newer than the branch's own. Every lookup by branch takes the
// first that isn't a fork's, as the app does, or is the one the branch
// was checked out from (checkedOutPullRequest). describe takes only the
// first that isn't a fork's (cmd_describe.go).
func prLookupArgs(branch string, extraFields ...string) []string {
	return []string{"pr", "list", "--state", "all", "--head", branch, "--limit", "10", "--json", prFields(extraFields...)}
}

func mergeLookupArgs(branch string) []string {
	return prLookupArgs(branch, mergeFields)
}

// The fork PR the branch was checked out from, 0 for none. The app's
// PR checkout, like `gh pr checkout`, points branch.<b>.merge at
// refs/pull/<n>/head, and that PR is the branch's own though it comes
// from a fork. A git call, so the lookups only make it once gh has
// returned a fork's PR.
func checkedOutPullRequest(repoPath, branch string) int {
	ref, err := runGit(repoPath, "config", "--get", "branch."+branch+".merge")
	if err != nil {
		return 0
	}
	pull, isPull := strings.CutPrefix(strings.TrimSpace(ref), "refs/pull/")
	pull, isHead := strings.CutSuffix(pull, "/head")
	if number, err := strconv.Atoi(pull); isPull && isHead && err == nil {
		return number
	}
	return 0
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
	return findPullRequestWith(projectPath, branch, prLookupArgs(branch))
}

func findPullRequestWith(projectPath, branch string, args []string) (*prSummary, error) {
	prs, err := ghPrList(projectPath, args...)
	if err != nil {
		return nil, err
	}
	checkedOut := sync.OnceValue(func() int { return checkedOutPullRequest(projectPath, branch) })
	for i := range prs {
		if !prs[i].IsCrossRepository || prs[i].Number == checkedOut() {
			return &prs[i], nil
		}
	}
	return nil, nil
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
		return findPullRequestWith(projectPath, branch, mergeLookupArgs(branch))
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
// two leave the PR open, and merge and land wait on them (awaitMerge).
const (
	outcomeMerged    = "merged"
	outcomeQueued    = "queued"
	outcomeAutoMerge = "auto-merge"
)

type mergeOutcome struct {
	method  string
	outcome string
	// An auto-merge armed before this merge, which it left as it was.
	alreadyArmed bool
}

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
		if o.alreadyArmed {
			verb = "auto-merge already enabled for"
		}
	}
	return greenOut(fmt.Sprintf("%s PR #%d (%s): %s", verb, pr.Number, o.method, pr.Title))
}

// What to run next: the cleanup, now the PR has landed.
func mergeNextHint(id worktreeIdentity) string {
	return fmt.Sprintf("next: `%s done` (primary checkout) or `%s rm %s` (managed worktree)",
		binaryName, binaryName, id.Name)
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
		if pr.IsCrossRepository && checkedOutPullRequest(proj.Path, pr.HeadRefName) != number {
			return 1, codedErrf("fork-pull-request", "PR #%d is from a fork, and its branch here wasn't checked out from it. Merge it on GitHub instead.", number)
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
	if err := awaitMerge(proj.Path, pr, o, "merge"); err != nil {
		return exitCodeOf(err), err
	}
	o.outcome = outcomeMerged

	if jsonMode {
		doc := mergeResultFields(pr, id.Branch, o.method)
		doc["ok"] = true
		o.addTo(doc)
		emit(doc)
	} else {
		out(o.line(pr))
		note(dimErr(mergeNextHint(id)))
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
	if _, err := runGh(projectPath, "pr", "merge", fmt.Sprint(number), "--"+method); err != nil {
		queued, err := mergeStackedAlone(projectPath, number, method, err)
		if err != nil {
			return mergeOutcome{}, err
		}
		if queued {
			return mergeOutcome{method: method, outcome: outcomeQueued}, nil
		}
		return mergeOutcome{method: method, outcome: outcomeMerged}, nil
	}
	return readBackOutcome(projectPath, number, mergeOutcome{method: method, outcome: outcomeMerged}), nil
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
// are met.
func armAutoMerge(projectPath string, pr *prSummary, method string) (mergeOutcome, error) {
	if armed := pr.AutoMergeRequest; armed != nil {
		// GitHub refuses a second enable, and the PR lands on its
		// own with what is armed.
		return mergeOutcome{method: cmp.Or(armed.method(), method), outcome: outcomeAutoMerge, alreadyArmed: true}, nil
	}
	if _, err := runGh(projectPath, "pr", "merge", fmt.Sprint(pr.Number), "--auto", "--"+method); err != nil {
		return mergeOutcome{}, err
	}
	return readBackOutcome(projectPath, pr.Number, mergeOutcome{method: method, outcome: outcomeAutoMerge}), nil
}

// A merge gh accepted doesn't always end the way it was asked to: --auto
// merges at once when the verdict has moved since the lookup, and on a
// base branch with a merge queue either merge queues the PR. So the
// outcome is read back off the PR rather than assumed. A read that
// fails leaves the one asked for, since it only shapes the report and
// the wait.
func readBackOutcome(projectPath string, number int, asked mergeOutcome) mergeOutcome {
	after, err := readMergeProgress(projectPath, number)
	switch {
	case err != nil:
	case after.State == "MERGED":
		asked.outcome = outcomeMerged
	case after.IsInMergeQueue:
		asked.outcome = outcomeQueued
	case after.AutoMergeRequest != nil:
		asked.outcome = outcomeAutoMerge
	}
	return asked
}

// GraphQL, since `gh pr view --json` exposes neither isInMergeQueue
// nor whether a check is required. isRequired is what lets the wait
// (awaitMerge) go on past a failing check GitHub merges past anyway. The number goes first so a test's fake gh can tell this
// query from the repo settings' by its prefix.
const mergeProgressQuery = "query($number: Int!, $owner: String!, $name: String!) { repository(owner: $owner, name: $name) " +
	"{ pullRequest(number: $number) { state mergeStateStatus reviewDecision isInMergeQueue autoMergeRequest { mergeMethod } " +
	"commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { " +
	"... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) } " +
	"... on StatusContext { context state isRequired(pullRequestNumber: $number) } } } } } } } } } }"

// Where an open PR stands on its way to merging.
type mergeProgress struct {
	State            string
	MergeStateStatus string
	ReviewDecision   string
	IsInMergeQueue   bool
	AutoMergeRequest *autoMergeRequest
	// The head commit's checks.
	Checks []prCheck
}

type prCheck struct {
	checkNode
	Name       string `json:"name"`
	Context    string `json:"context"`
	IsRequired bool   `json:"isRequired"`
}

func readMergeProgress(projectPath string, number int) (mergeProgress, error) {
	stdout, err := runGh(projectPath, "api", "graphql", "-F", "number="+fmt.Sprint(number),
		"-F", "owner={owner}", "-F", "name={repo}", "-f", "query="+mergeProgressQuery)
	if err != nil {
		return mergeProgress{}, err
	}
	return parseMergeProgress(stdout)
}

func parseMergeProgress(stdout string) (mergeProgress, error) {
	var parsed struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					State            string            `json:"state"`
					MergeStateStatus string            `json:"mergeStateStatus"`
					ReviewDecision   string            `json:"reviewDecision"`
					IsInMergeQueue   bool              `json:"isInMergeQueue"`
					AutoMergeRequest *autoMergeRequest `json:"autoMergeRequest"`
					Commits          struct {
						Nodes []struct {
							Commit struct {
								StatusCheckRollup *struct {
									Contexts struct {
										Nodes []prCheck `json:"nodes"`
									} `json:"contexts"`
								} `json:"statusCheckRollup"`
							} `json:"commit"`
						} `json:"nodes"`
					} `json:"commits"`
				} `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &parsed); err != nil {
		return mergeProgress{}, errf("unexpected gh api output: %s", err)
	}
	pr := parsed.Data.Repository.PullRequest
	progress := mergeProgress{
		State: pr.State, MergeStateStatus: pr.MergeStateStatus, ReviewDecision: pr.ReviewDecision,
		IsInMergeQueue: pr.IsInMergeQueue, AutoMergeRequest: pr.AutoMergeRequest,
	}
	for _, commit := range pr.Commits.Nodes {
		if rollup := commit.Commit.StatusCheckRollup; rollup != nil {
			progress.Checks = append(progress.Checks, rollup.Contexts.Nodes...)
		}
	}
	return progress, nil
}

var autoMergePollInterval = 10 * time.Second

// A read that fails this many times in a row ends the wait. One that
// fails now and then (a network blip) is waited out.
const autoMergeReadAttempts = 5

// How many polls in a row (about five minutes) a PR may sit BLOCKED
// with nothing the wait can see to wait on before it counts as stuck:
// a required check that never reports, say, or a rule the reads don't
// cover.
const autoMergeStallPolls = 30

// Waits for a PR that didn't merge on the spot (auto-merge armed, or a
// merge queue took it) until GitHub merges it. Every other way out is
// an error naming what the PR needs, and the command to run again once
// it's dealt with.
func awaitMerge(projectPath string, pr *prSummary, o mergeOutcome, command string) error {
	if o.outcome == outcomeMerged {
		return nil
	}
	if !jsonMode {
		out(o.line(pr))
	}
	queued := o.outcome == outcomeQueued
	lastNote, lastProblem := "", ""
	failedReads, stalledPolls := 0, 0
	for ; ; time.Sleep(autoMergePollInterval) {
		progress, err := readMergeProgress(projectPath, pr.Number)
		if err != nil {
			if failedReads++; failedReads == autoMergeReadAttempts {
				return errf("Lost track of PR #%d: %s. Run `%s %s` again to keep waiting",
					pr.Number, err, binaryName, command)
			}
			continue
		}
		failedReads = 0
		if progress.State == "MERGED" {
			return nil
		}
		queued = queued || progress.IsInMergeQueue
		problem, waitingOn := progress.problem(pr.BaseRefName, queued), progress.waitingOn()
		if problem == "" && waitingOn == "" && progress.MergeStateStatus == "BLOCKED" {
			if stalledPolls++; stalledPolls >= autoMergeStallPolls {
				problem = "GitHub is holding it back for a reason sm can't see"
			}
		} else {
			stalledPolls = 0
		}
		// A problem counts once two reads in a row see it: one read can
		// fall between two of GitHub's steps, like auto-merge handing
		// the PR to a merge queue, or the queue landing it.
		if problem != "" && problem == lastProblem {
			return codedErrf("needs-attention", "PR #%d needs attention: %s (%s). Run `%s %s` again once it's dealt with",
				pr.Number, problem, pr.URL, binaryName, command)
		}
		if lastProblem = problem; problem != "" {
			continue
		}
		line := "waiting for GitHub to merge it"
		if waitingOn != "" {
			line += ": " + waitingOn
		}
		if line != lastNote {
			lastNote = line
			note(dimErr(line))
		}
	}
}

func (p mergeProgress) requiredChecks(verdict checkVerdict) []string {
	var names []string
	for _, check := range p.Checks {
		if check.IsRequired && check.verdict() == verdict {
			names = append(names, cmp.Or(check.Name, check.Context))
		}
	}
	return names
}

// Why GitHub won't merge the PR without a person, or "" while it still
// might. GitHub doesn't update a branch that is behind for auto-merge,
// so BEHIND waits on a person too. A merge queue brings the PR up to
// date and runs its checks itself, so a queued PR waits on the queue.
// queued is whether the PR has been in one, which takes it out again
// when its checks fail.
func (p mergeProgress) problem(base string, queued bool) string {
	switch {
	case p.State == "CLOSED":
		return "it was closed"
	case p.IsInMergeQueue:
		return ""
	case p.AutoMergeRequest == nil && queued:
		return "it left the merge queue unmerged"
	case p.AutoMergeRequest == nil:
		return "auto-merge was turned off"
	case p.MergeStateStatus == "DIRTY":
		return "it conflicts with " + base
	case p.MergeStateStatus == "BEHIND":
		return "it is behind " + base + " and needs updating"
	case p.ReviewDecision == "CHANGES_REQUESTED":
		return "changes were requested"
	}
	if failed := p.requiredChecks(checkFailing); len(failed) == 1 {
		return "check " + failed[0] + " failed"
	} else if len(failed) > 1 {
		return "checks " + strings.Join(failed, ", ") + " failed"
	}
	return ""
}

func (p mergeProgress) waitingOn() string {
	switch {
	case p.IsInMergeQueue:
		return "it is in the merge queue"
	case len(p.requiredChecks(checkPending)) > 0:
		return "checks are running"
	case p.ReviewDecision == "REVIEW_REQUIRED":
		return "it needs a review"
	}
	return ""
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
