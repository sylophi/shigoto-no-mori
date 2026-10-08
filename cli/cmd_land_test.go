package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// The catch-up must land in the checkout that has the base branch out
// and nowhere else: pulling v2 into the primary checkout would move
// main onto v2.
func TestCheckoutOn(t *testing.T) {
	primary := worktreeIdentity{Name: "shigoto-no-mori", Branch: "main", Path: "/repo", IsPrimary: true}
	v2 := worktreeIdentity{Name: "v2", Branch: "v2", Path: "/wt/v2"}
	parked := worktreeIdentity{Name: "parked", Branch: "v2", Path: "/wt/parked", Detached: true}
	identities := []worktreeIdentity{primary, parked, v2}

	if got, ok := checkoutOn(identities, "v2"); !ok || got.Path != v2.Path {
		t.Errorf("checkoutOn(v2) = %+v, %v, want the v2 worktree", got, ok)
	}
	if got, ok := checkoutOn(identities, "main"); !ok || !got.IsPrimary {
		t.Errorf("checkoutOn(main) = %+v, %v, want the primary checkout", got, ok)
	}
	if got, ok := checkoutOn(identities, "release"); ok {
		t.Errorf("checkoutOn(release) = %+v, want no match", got)
	}
}

func jsonFieldsOf(t *testing.T, args []string) []string {
	t.Helper()
	for i, a := range args {
		if a == "--json" && i+1 < len(args) {
			return strings.Split(args[i+1], ",")
		}
	}
	t.Fatalf("no --json field list in %v", args)
	return nil
}

// The base ref has to survive the gh lookup, or land falls back to the
// unknown-base path and the guard above never fires in practice. The
// merge's lookup adds the verdict and the armed auto-merge, without
// which it could never tell a waiting PR from one it can land now.
// The plain lookup (sm pr, the stack walks) doesn't pay for the verdict.
func TestPrLookupArgsRequestTheRightFields(t *testing.T) {
	plain := jsonFieldsOf(t, prLookupArgs("some-branch"))
	if !slices.Contains(plain, "baseRefName") {
		t.Errorf("prLookupArgs --json fields = %q, want baseRefName among them", plain)
	}
	if slices.Contains(plain, "mergeStateStatus") {
		t.Errorf("prLookupArgs --json fields = %q, want no merge verdict on the plain lookup", plain)
	}
	merge := jsonFieldsOf(t, mergeLookupArgs("some-branch"))
	for _, want := range []string{"baseRefName", "mergeStateStatus", "autoMergeRequest"} {
		if !slices.Contains(merge, want) {
			t.Errorf("mergeLookupArgs --json fields = %q, want %s among them", merge, want)
		}
	}
}

// Verbatim `gh pr list` output for the field list above, so a struct
// tag that stops matching gh's spelling fails here instead of silently
// leaving every base empty and re-enabling the false catch-up, or
// every verdict empty and never arming auto-merge.
func TestPrSummaryDecodesTheMergeFields(t *testing.T) {
	const ghOutput = `[{"autoMergeRequest":null,"baseRefName":"v2","isDraft":false,` +
		`"mergeStateStatus":"BLOCKED","number":249,` +
		`"state":"MERGED","title":"Reword device revoke",` +
		`"url":"https://github.com/o/r/pull/249"},` +
		`{"autoMergeRequest":{"enabledAt":"2026-09-27T10:00:00Z","mergeMethod":"SQUASH"},` +
		`"baseRefName":"main","isDraft":false,"mergeStateStatus":"BLOCKED","number":250,` +
		`"state":"OPEN","title":"Armed","url":"https://github.com/o/r/pull/250"}]`
	var prs []prSummary
	if err := json.Unmarshal([]byte(ghOutput), &prs); err != nil {
		t.Fatalf("decoding gh output: %v", err)
	}
	if len(prs) != 2 {
		t.Fatalf("decoded %d pull requests, want 2", len(prs))
	}
	if prs[0].BaseRefName != "v2" {
		t.Errorf("BaseRefName = %q, want %q", prs[0].BaseRefName, "v2")
	}
	if prs[0].MergeStateStatus != "BLOCKED" || prs[0].AutoMergeRequest != nil {
		t.Errorf("PR #249 = verdict %q, armed %v; want BLOCKED and nothing armed", prs[0].MergeStateStatus, prs[0].AutoMergeRequest)
	}
	if armed := prs[1].AutoMergeRequest; armed == nil || armed.method() != "squash" {
		t.Errorf("PR #250 armed auto-merge = %+v, want squash", armed)
	}
}

// Auto-merge is for a PR waiting on its base branch's rules, or on a
// catch-up with the base. A verdict that allows the merge merges now,
// and a conflict or a verdict GitHub hasn't computed keeps the plain
// merge's refusal.
func TestAutoMergeArms(t *testing.T) {
	for status, want := range map[string]bool{
		"BLOCKED": true, "BEHIND": true,
		"CLEAN": false, "HAS_HOOKS": false, "UNSTABLE": false,
		"DIRTY": false, "DRAFT": false, "UNKNOWN": false, "": false,
	} {
		if got := autoMergeArms(status); got != want {
			t.Errorf("autoMergeArms(%q) = %v, want %v", status, got, want)
		}
	}
}

// A gh on PATH for a one-PR land on a repo that allows auto-merge: the
// fox branch's PR #5 is waiting on its checks (BLOCKED), posable as
// already armed through GH_FOX_AUTO. GH_FOX_AFTER poses the state the
// read-back after the --auto merge sees. Each poll of land's wait
// takes the next line of the file at GH_FOX_POLLS, the last one
// answering every poll after it. Every invocation is appended to a log.
func fakeGhAutoMerge(t *testing.T) (log string) {
	t.Helper()
	bin := t.TempDir()
	log = filepath.Join(bin, "gh.log")
	script := `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$*" in
  "pr list --state all --head fox --limit 10 --json "*) echo '[{"number":5,"title":"Fox","state":"OPEN","isDraft":false,"url":"u5","baseRefName":"main","headRefName":"fox","mergeStateStatus":"BLOCKED","autoMergeRequest":'"${GH_FOX_AUTO:-null}"'}]';;
  "api graphql -F number=5 "*mergeStateStatus*)
    head -n 1 "$GH_FOX_POLLS"
    if [ "$(wc -l < "$GH_FOX_POLLS")" -gt 1 ]; then
      tail -n +2 "$GH_FOX_POLLS" > "$GH_FOX_POLLS.next" && mv "$GH_FOX_POLLS.next" "$GH_FOX_POLLS"
    fi;;
  "api graphql -F number=5 "*) echo '{"data":{"repository":{"pullRequest":{"state":"'"${GH_FOX_AFTER:-OPEN}"'","isInMergeQueue":false,"autoMergeRequest":{"mergeMethod":"SQUASH"}}}}}';;
  "api graphql "*) echo '{"data":{"repository":{"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":true,"autoMergeAllowed":true}}}';;
  "pr merge 5 --auto --squash") ;;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GH_LOG", log)
	t.Setenv("GH_FOX_POLLS", filepath.Join(bin, "polls"))
	pollFast(t)
	return log
}

func pollFast(t *testing.T) {
	t.Helper()
	interval := autoMergePollInterval
	autoMergePollInterval = time.Millisecond
	t.Cleanup(func() { autoMergePollInterval = interval })
}

// What the polls of land's wait see, one poll per line.
func posePolls(t *testing.T, polls ...string) {
	t.Helper()
	if err := os.WriteFile(os.Getenv("GH_FOX_POLLS"), []byte(strings.Join(polls, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// One poll's answer: the PR's state, its verdict and review decision,
// whether auto-merge is armed, and its checks as name=verdict pairs, a
// trailing ! marking a required one.
func poll(state, verdict, review string, armed bool, checks ...string) string {
	pr := map[string]any{"state": state, "mergeStateStatus": verdict, "reviewDecision": review, "isInMergeQueue": false}
	if armed {
		pr["autoMergeRequest"] = map[string]any{"mergeMethod": "SQUASH"}
	} else {
		pr["autoMergeRequest"] = nil
	}
	var contexts []map[string]any
	for _, check := range checks {
		name, conclusion, _ := strings.Cut(check, "=")
		required := strings.HasSuffix(conclusion, "!")
		conclusion = strings.TrimSuffix(conclusion, "!")
		node := map[string]any{"name": name, "status": "COMPLETED", "conclusion": conclusion, "isRequired": required}
		if conclusion == "" {
			node["status"] = "IN_PROGRESS"
		}
		contexts = append(contexts, node)
	}
	pr["commits"] = map[string]any{"nodes": []any{map[string]any{"commit": map[string]any{
		"statusCheckRollup": map[string]any{"contexts": map[string]any{"nodes": contexts}},
	}}}}
	raw, err := json.Marshal(map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": pr}}})
	if err != nil {
		panic(err)
	}
	return string(raw)
}

func landFixture(t *testing.T) (project, cliContext) {
	t.Helper()
	root := sandboxDataDir(t)
	upstream := seedRepo(t, root, "upstream")
	repo := filepath.Join(root, "repo")
	mustGit(t, root, "clone", "-q", upstream, repo)
	proj, err := registerProject(repo)
	if err != nil {
		t.Fatal(err)
	}
	w, err := createWorktree(proj, "fox", "fox", "main", false, true)
	if err != nil {
		t.Fatal(err)
	}
	commitEmpty(t, w.Path, "fox")
	return proj, resolveContext(proj.Path, []project{proj})
}

func mergeCalls(t *testing.T, log string) []string {
	t.Helper()
	var calls []string
	for _, call := range ghCalls(t, log) {
		if strings.HasPrefix(call, "pr merge ") {
			calls = append(calls, call)
		}
	}
	return calls
}

func foxSurvives(t *testing.T, proj project) bool {
	t.Helper()
	identities, err := listWorktreeIdentitiesUncached(proj)
	if err != nil {
		t.Fatal(err)
	}
	_, ok := checkoutOn(identities, "fox")
	return ok
}

// End to end with a real worktree: landing a PR that is waiting on its
// checks, on a repo that allows auto-merge, arms auto-merge with the
// first allowed method and waits. A failing check GitHub doesn't
// require doesn't end the wait, and once GitHub has merged the PR,
// land goes on to the cleanup.
func TestLandWaitsForAutoMergeThenCleansUp(t *testing.T) {
	proj, ctx := landFixture(t)
	log := fakeGhAutoMerge(t)
	posePolls(t,
		poll("OPEN", "BLOCKED", "", true, "build=!", "lint=FAILURE"),
		poll("OPEN", "BLOCKED", "", true, "build=SUCCESS!", "lint=FAILURE"),
		poll("MERGED", "UNKNOWN", "", false),
	)

	if code, err := cmdLand(ctx, []string{"fox"}); err != nil || code != 0 {
		t.Fatalf("land = %d, %v", code, err)
	}
	if got := mergeCalls(t, log); strings.Join(got, ";") != "pr merge 5 --auto --squash" {
		t.Errorf("gh merge calls = %q, want the one --auto merge", got)
	}
	if foxSurvives(t, proj) {
		t.Error("the worktree survived the land of its merged PR")
	}
}

// A PR GitHub won't merge without a person ends the wait with an error
// saying why, and removes nothing. Landing again once it's dealt with
// arms nothing new and waits on the armed auto-merge again.
func TestLandStopsWhenTheAutoMergedPRNeedsAttention(t *testing.T) {
	for _, tc := range []struct {
		name, poll, want string
	}{
		{"required check failed", poll("OPEN", "BLOCKED", "", true, "build=FAILURE!", "lint=SUCCESS"), "check build failed"},
		{"auto-merge turned off", poll("OPEN", "BLOCKED", "", false), "auto-merge was turned off"},
		{"conflict", poll("OPEN", "DIRTY", "", true), "it conflicts with main"},
		{"behind", poll("OPEN", "BEHIND", "", true), "it is behind main"},
		{"changes requested", poll("OPEN", "BLOCKED", "CHANGES_REQUESTED", true), "changes were requested"},
		{"closed", poll("CLOSED", "UNKNOWN", "", false), "it was closed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proj, ctx := landFixture(t)
			log := fakeGhAutoMerge(t)
			posePolls(t, poll("OPEN", "BLOCKED", "REVIEW_REQUIRED", true, "build=!"), tc.poll)

			_, err := cmdLand(ctx, []string{"fox"})
			if err == nil || errorKindOf(err) != "needs-attention" || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("land error = %v, want needs-attention saying %q", err, tc.want)
			}
			if !foxSurvives(t, proj) {
				t.Fatal("the worktree was removed while its PR needs attention")
			}

			t.Setenv("GH_FOX_AUTO", `{"mergeMethod":"SQUASH"}`)
			posePolls(t, poll("MERGED", "UNKNOWN", "", false))
			if code, err := cmdLand(ctx, []string{"fox"}); err != nil || code != 0 {
				t.Fatalf("land again = %d, %v", code, err)
			}
			if got := mergeCalls(t, log); len(got) != 1 {
				t.Errorf("landing an armed PR merged again: %q", got)
			}
			if foxSurvives(t, proj) {
				t.Error("the worktree survived the land of its merged PR")
			}
		})
	}
}

// The verdict can flip between the lookup and the merge, and gh's
// --auto then merges at once. The read-back after it is what tells
// land so, and land goes on to the cleanup instead of reporting an
// armed auto-merge on a PR that has landed.
func TestLandReadsBackAnAutoMergeThatMergedAtOnce(t *testing.T) {
	proj, ctx := landFixture(t)
	log := fakeGhAutoMerge(t)
	t.Setenv("GH_FOX_AFTER", "MERGED")

	if code, err := cmdLand(ctx, []string{"fox"}); err != nil || code != 0 {
		t.Fatalf("land = %d, %v", code, err)
	}
	if !slices.Contains(ghCalls(t, log), "pr merge 5 --auto --squash") {
		t.Errorf("gh calls = %q, want the --auto merge among them", ghCalls(t, log))
	}
	if foxSurvives(t, proj) {
		t.Error("the worktree survived a land whose --auto merge landed at once")
	}
}

func headOf(t *testing.T, dir, rev string) string {
	t.Helper()
	sha, err := runGit(dir, "rev-parse", rev)
	if err != nil {
		t.Fatalf("rev-parse %s in %s: %v", rev, dir, err)
	}
	return strings.TrimSpace(sha)
}

// End to end against real git: the slip this guards is a land whose PR
// merged into v2, followed by a by-hand fast-forward that moved main
// onto v2 in the primary checkout. The catch-up has to pull v2 in the
// worktree that has it out, and leave main exactly where it was.
func TestCatchUpBasePullsTheBaseBranchCheckout(t *testing.T) {
	root := sandboxDataDir(t)
	upstream := seedRepo(t, root, "upstream")
	mustGit(t, upstream, "branch", "v2")
	repo := filepath.Join(root, "repo")
	mustGit(t, root, "clone", "-q", upstream, repo)
	proj, err := registerProject(repo)
	if err != nil {
		t.Fatal(err)
	}
	v2, err := createWorktree(proj, "v2", "", "origin/v2", true, true)
	if err != nil {
		t.Fatal(err)
	}
	v2Path := v2.Path
	pt, err := resolvePrimaryTarget(proj)
	if err != nil {
		t.Fatal(err)
	}

	mainBefore := headOf(t, repo, "main")
	v2Before := headOf(t, v2Path, "v2")

	// The merged PR: v2 moves on the remote, main does not.
	mustGit(t, upstream, "checkout", "-q", "v2")
	commitEmpty(t, upstream, "merged into v2")
	v2Merged := headOf(t, upstream, "v2")
	if v2Merged == v2Before {
		t.Fatal("upstream v2 did not advance")
	}

	cu := catchUpBase(proj, pt, "v2")
	if cu.ref == "" {
		t.Fatalf("catch-up skipped: %q", cu.skip)
	}
	if cu.ref != "origin/v2" {
		t.Errorf("caught up from %s, want origin/v2", cu.ref)
	}
	if cu.checkout.Path != v2Path || cu.checkout.IsPrimary {
		t.Errorf("pulled checkout = %+v, want the v2 worktree", cu.checkout)
	}
	if got := headOf(t, v2Path, "HEAD"); got != v2Merged {
		t.Errorf("v2 worktree HEAD = %s, want the merged commit %s", got, v2Merged)
	}
	if got := headOf(t, repo, "main"); got != mainBefore {
		t.Errorf("main moved from %s to %s, and the catch-up must never touch it", mainBefore, got)
	}
	if branch, _ := runGit(repo, "symbolic-ref", "--short", "HEAD"); strings.TrimSpace(branch) != "main" {
		t.Errorf("primary checkout is on %q, want main", strings.TrimSpace(branch))
	}

	// The incident itself: pulling v2 into the checkout that is on
	// main. Without the HEAD check git would fast-forward main onto
	// v2, since main is its ancestor.
	if err := ffPull(repo, "origin", "v2"); err == nil {
		t.Error("ffPull of v2 in the main checkout succeeded, want a refusal")
	}
	if got := headOf(t, repo, "main"); got != mainBefore {
		t.Errorf("main moved to %s after the refused pull", got)
	}

	// A base nobody has checked out: reported, nothing pulled.
	cu = catchUpBase(proj, pt, "release")
	if cu.ref != "" || cu.skip != "no checkout is on release" {
		t.Errorf("catch-up of an unchecked-out base = %+v, want a skip", cu)
	}

	// An unreadable base falls back to the primary branch, pulled in
	// the primary checkout.
	mustGit(t, upstream, "checkout", "-q", "main")
	commitEmpty(t, upstream, "merged into main")
	mainMerged := headOf(t, upstream, "main")
	cu = catchUpBase(proj, pt, "")
	if !cu.checkout.IsPrimary || cu.ref != "origin/main" {
		t.Fatalf("primary catch-up = %+v (skip %q), want origin/main into the primary checkout", cu, cu.skip)
	}
	if got := headOf(t, repo, "main"); got != mainMerged {
		t.Errorf("main = %s, want %s", got, mainMerged)
	}
	if got := headOf(t, v2Path, "HEAD"); got != v2Merged {
		t.Errorf("v2 worktree moved to %s during the main catch-up", got)
	}
}

// A stack land removes the worktrees of the layers that landed and no
// other: the layer that was merged before, the layers the merge lands
// now, never the top itself (the plain cleanup takes it), the primary
// checkout, or a detached checkout parked on a landed branch.
func TestLandingLayersAndWorktrees(t *testing.T) {
	chain := []prSummary{
		{Number: 2, State: "MERGED", HeadRefName: "layer-a", BaseRefName: "main"},
		{Number: 3, State: "OPEN", HeadRefName: "layer-b", BaseRefName: "layer-a"},
		{Number: 4, State: "OPEN", HeadRefName: "layer-c", BaseRefName: "layer-b"},
	}
	landing := landingLayers(chain, chain[1:])
	if !landing["layer-a"] || !landing["layer-b"] || landing["layer-c"] {
		t.Errorf("landingLayers = %v, want layer-a and layer-b only", landing)
	}

	// A resume: the top is merged, layer-b was left open somehow.
	resumed := []prSummary{chain[0], chain[1], {Number: 4, State: "MERGED", HeadRefName: "layer-c", BaseRefName: "layer-b"}}
	if got := landingLayers(resumed, nil); !got["layer-a"] || got["layer-b"] {
		t.Errorf("landingLayers on resume = %v, want layer-a only", got)
	}

	self := worktreeIdentity{ID: "c", Name: "c", Branch: "layer-c", Path: "/wt/c"}
	identities := []worktreeIdentity{
		{ID: "p", Name: "repo", Branch: "layer-a", Path: "/repo", IsPrimary: true},
		{ID: "b", Name: "b", Branch: "layer-b", Path: "/wt/b"},
		{ID: "parked", Name: "parked", Branch: "layer-b", Path: "/wt/parked", Detached: true},
		self,
		{ID: "x", Name: "x", Branch: "other", Path: "/wt/x"},
	}
	others := landedWorktrees(identities, landing, self)
	if len(others) != 1 || others[0].ID != "b" {
		t.Errorf("landedWorktrees = %+v, want just the layer-b worktree", others)
	}
}
