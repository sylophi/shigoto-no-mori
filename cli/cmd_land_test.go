package main

import (
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"testing"
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

// The base ref has to survive the gh lookup, or land falls back to the
// unknown-base path and the guard above never fires in practice.
func TestPrLookupArgsRequestsBaseRefName(t *testing.T) {
	args := prLookupArgs("some-branch")
	var fields string
	for i, a := range args {
		if a == "--json" && i+1 < len(args) {
			fields = args[i+1]
		}
	}
	if fields == "" {
		t.Fatalf("prLookupArgs produced no --json field list: %v", args)
	}
	if !slices.Contains(strings.Split(fields, ","), "baseRefName") {
		t.Errorf("prLookupArgs --json fields = %q, want baseRefName among them", fields)
	}
}

// Verbatim `gh pr list` output for the field list above, so a struct
// tag that stops matching gh's spelling fails here instead of silently
// leaving every base empty and re-enabling the false catch-up.
func TestPrSummaryDecodesBaseRefName(t *testing.T) {
	const ghOutput = `[{"baseRefName":"v2","isDraft":false,"number":249,` +
		`"state":"MERGED","title":"Reword device revoke",` +
		`"url":"https://github.com/o/r/pull/249"}]`
	var prs []prSummary
	if err := json.Unmarshal([]byte(ghOutput), &prs); err != nil {
		t.Fatalf("decoding gh output: %v", err)
	}
	if len(prs) != 1 {
		t.Fatalf("decoded %d pull requests, want 1", len(prs))
	}
	if prs[0].BaseRefName != "v2" {
		t.Errorf("BaseRefName = %q, want %q", prs[0].BaseRefName, "v2")
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
	root := sandboxRoot(t)
	upstream := seedRepo(t, root, "upstream")
	mustGit(t, upstream, "branch", "v2")
	repo := filepath.Join(root, "repo")
	mustGit(t, root, "clone", "-q", upstream, repo)
	proj, err := registerProject(repo)
	if err != nil {
		t.Fatal(err)
	}
	v2, err := createWorktree(proj, "v2", "", "origin/v2", true)
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
