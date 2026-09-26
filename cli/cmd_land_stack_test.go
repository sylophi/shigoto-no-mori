package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A gh on PATH that answers from a script: the PR list of a three-layer
// chain (#2 layer-a merged, #3 layer-b and #4 layer-c open, layer-b
// posable as merged through GH_LAYER_B_STATE), no
// GitHub stack for any of them, every merge method allowed, and a
// mergeable verdict after a retarget. Every invocation is appended to
// a log the test reads back, and a merge advances upstream main so the
// catch-up has something to pull.
func fakeGh(t *testing.T, upstream string) (log string) {
	t.Helper()
	bin := t.TempDir()
	log = filepath.Join(bin, "gh.log")
	script := `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$*" in
  "pr list --state all --head layer-a --limit 1 --json "*) echo '[{"number":2,"title":"A","state":"MERGED","isDraft":false,"url":"u2","baseRefName":"main","headRefName":"layer-a"}]';;
  "pr list --state all --head layer-b --limit 1 --json "*) echo '[{"number":3,"title":"B","state":"'"${GH_LAYER_B_STATE:-OPEN}"'","isDraft":false,"url":"u3","baseRefName":"layer-a","headRefName":"layer-b"}]';;
  "pr list --state all --head layer-c --limit 1 --json "*) echo '[{"number":4,"title":"C","state":"OPEN","isDraft":false,"url":"u4","baseRefName":"layer-b","headRefName":"layer-c"}]';;
  "pr list --state all --head "*) echo '[]';;
  "pr list --state all --limit 200 --json "*) echo '[{"number":4,"title":"C","state":"OPEN","isDraft":false,"url":"u4","baseRefName":"layer-b","headRefName":"layer-c"},{"number":3,"title":"B","state":"'"${GH_LAYER_B_STATE:-OPEN}"'","isDraft":false,"url":"u3","baseRefName":"layer-a","headRefName":"layer-b"},{"number":2,"title":"A","state":"MERGED","isDraft":false,"url":"u2","baseRefName":"main","headRefName":"layer-a"}]';;
  "repo view --json "*) echo '{"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true}';;
  "api repos/{owner}/{repo}/stacks?pull_request="*) echo "gh: Not Found (HTTP 404)" >&2; exit 1;;
  "pr view "*) echo '{"mergeStateStatus":"CLEAN"}';;
  "pr edit "*) ;;
  "pr merge "*) git -C "$GH_UPSTREAM" commit -q --allow-empty -m "merged $2";;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GH_LOG", log)
	t.Setenv("GH_UPSTREAM", upstream)
	return log
}

func ghCalls(t *testing.T, log string) []string {
	t.Helper()
	raw, err := os.ReadFile(log)
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}

func worktreeOn(t *testing.T, proj project, branch string) worktreeIdentity {
	t.Helper()
	identities, err := listWorktreeIdentitiesUncached(proj)
	if err != nil {
		t.Fatal(err)
	}
	id, ok := checkoutOn(identities, branch)
	if !ok {
		t.Fatalf("no worktree is on %s", branch)
	}
	return id
}

// The chain as worktrees: layer-a under layer-b under layer-c, each a
// managed worktree of a clone whose upstream plays GitHub.
func seedStack(t *testing.T) (proj project, upstream string) {
	t.Helper()
	root := sandboxDataDir(t)
	upstream = seedRepo(t, root, "upstream")
	repo := filepath.Join(root, "repo")
	mustGit(t, root, "clone", "-q", upstream, repo)
	proj, err := registerProject(repo)
	if err != nil {
		t.Fatal(err)
	}
	base := "main"
	for _, layer := range []string{"layer-a", "layer-b", "layer-c"} {
		w, err := createWorktree(proj, layer, layer, base, false)
		if err != nil {
			t.Fatal(err)
		}
		commitEmpty(t, w.Path, layer)
		base = layer
	}
	return proj, upstream
}

// End to end with real worktrees: landing the top of a plain chain
// merges the open layers bottom first, retargets the top at the trunk
// before merging it, catches the primary checkout up, and removes the
// worktree of every landed layer, the merged bottom's included.
func TestLandStackLandsTheChainAndRemovesItsWorktrees(t *testing.T) {
	proj, upstream := seedStack(t)
	log := fakeGh(t, upstream)
	top := worktreeOn(t, proj, "layer-c")
	pr, _, err := resolveMergeTarget(proj.Path, "layer-c")
	if err != nil || pr == nil || pr.Number != 4 {
		t.Fatalf("resolveMergeTarget = %+v, %v", pr, err)
	}
	mainBefore := headOf(t, proj.Path, "main")

	code, err := landStack(proj, top, pr, "", nil, removeOptions{preflighted: true})
	if err != nil || code != 0 {
		t.Fatalf("landStack = %d, %v", code, err)
	}

	var merges []string
	for _, call := range ghCalls(t, log) {
		if strings.HasPrefix(call, "pr merge ") || strings.HasPrefix(call, "pr edit ") {
			merges = append(merges, call)
		}
	}
	want := []string{"pr edit 3 --base main", "pr merge 3 --merge", "pr edit 4 --base main", "pr merge 4 --merge"}
	if strings.Join(merges, ";") != strings.Join(want, ";") {
		t.Errorf("gh merge calls = %q, want %q", merges, want)
	}
	identities, err := listWorktreeIdentitiesUncached(proj)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range identities {
		if !id.IsPrimary {
			t.Errorf("worktree %s (%s) survived the stack land", id.Name, id.Branch)
		}
	}
	if got := headOf(t, proj.Path, "main"); got == mainBefore {
		t.Error("the primary checkout was not caught up after the merge")
	}
}

// Uncommitted work in a lower layer's worktree stops the land before
// anything merges, the way the top's own guard does.
func TestLandStackRefusesADirtyLowerLayer(t *testing.T) {
	proj, upstream := seedStack(t)
	log := fakeGh(t, upstream)
	top := worktreeOn(t, proj, "layer-c")
	lower := worktreeOn(t, proj, "layer-b")
	if err := os.WriteFile(filepath.Join(lower.Path, "wip.txt"), []byte("wip"), 0o644); err != nil {
		t.Fatal(err)
	}
	pr, _, err := resolveMergeTarget(proj.Path, "layer-c")
	if err != nil {
		t.Fatal(err)
	}

	_, err = landStack(proj, top, pr, "", nil, removeOptions{preflighted: true})
	if err == nil || !strings.Contains(err.Error(), "worktree layer-b") {
		t.Fatalf("landStack on a dirty lower layer = %v, want a refusal naming it", err)
	}
	for _, call := range ghCalls(t, log) {
		if strings.HasPrefix(call, "pr merge ") {
			t.Errorf("a PR merged despite the refusal: %s", call)
		}
	}
}

// Without --stack a layer that sits on an open PR is a refusal, and a
// PR into the trunk is not.
func TestStackedUnder(t *testing.T) {
	proj, upstream := seedStack(t)
	fakeGh(t, upstream)
	pt, err := resolvePrimaryTarget(proj)
	if err != nil {
		t.Fatal(err)
	}
	top := prSummary{Number: 4, State: "OPEN", HeadRefName: "layer-c", BaseRefName: "layer-b"}
	below, err := stackedUnder(proj, &top, pt, nil)
	if err != nil || below == nil || below.Number != 3 {
		t.Errorf("stackedUnder(#4) = %+v, %v, want PR #3", below, err)
	}
	bottom := prSummary{Number: 2, State: "OPEN", HeadRefName: "layer-a", BaseRefName: "main"}
	if below, err := stackedUnder(proj, &bottom, pt, nil); err != nil || below != nil {
		t.Errorf("stackedUnder(#2) = %+v, %v, want nothing", below, err)
	}
}

// rm --stack is the cleanup alone: it refuses an open top, and on a
// landed stack removes the worktree and the merged layers' under it
// without a merge call.
func TestRmStackCleansUpALandedStackOnly(t *testing.T) {
	proj, upstream := seedStack(t)
	log := fakeGh(t, upstream)
	top := worktreeOn(t, proj, "layer-c")
	if _, err := rmStack(proj, top, removeOptions{}); err == nil || !strings.Contains(err.Error(), "still open") {
		t.Fatalf("rmStack on an open top = %v, want a refusal", err)
	}
	// layer-b's PR is merged, layer-a's below it too: both go, layer-c stays.
	middle := worktreeOn(t, proj, "layer-b")
	middle.Branch = "layer-b"
	t.Setenv("GH_LAYER_B_STATE", "MERGED")
	code, err := rmStack(proj, middle, removeOptions{})
	if err != nil || code != 0 {
		t.Fatalf("rmStack = %d, %v", code, err)
	}
	for _, call := range ghCalls(t, log) {
		if strings.HasPrefix(call, "pr merge ") || strings.HasPrefix(call, "pr edit ") {
			t.Errorf("rm --stack touched a PR: %s", call)
		}
	}
	identities, err := listWorktreeIdentitiesUncached(proj)
	if err != nil {
		t.Fatal(err)
	}
	var left []string
	for _, id := range identities {
		if !id.IsPrimary {
			left = append(left, id.Branch)
		}
	}
	if strings.Join(left, ",") != "layer-c" {
		t.Errorf("worktrees left = %v, want only layer-c", left)
	}
}
