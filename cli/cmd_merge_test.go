package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// A gh on PATH whose --head filter matches the branch name across
// every fork, as GitHub's does. fox has its own PR #5 (merged) and a
// stranger's newer fork PR #9 of the same name, which a --limit 1
// lookup sees alone. lone has only a fork PR #11 (merged). The full
// listing also has #8 stacked on layer-a, whose own PR #3 is older
// than a fork's layer-a PR #10. contrib was checked out from a fork's
// PR #42, beside a stranger's newer fork PR #13 of the same name. #9
// and #42 also answer by number, and a merge is only logged.
func fakeGhWithForks(t *testing.T) (log string) {
	t.Helper()
	bin := t.TempDir()
	log = filepath.Join(bin, "gh.log")
	fork9 := `{"number":9,"title":"Fork fox","state":"OPEN","isDraft":false,"url":"u9","baseRefName":"main","headRefName":"fox","isCrossRepository":true,"mergeStateStatus":"CLEAN","autoMergeRequest":null}`
	own5 := `{"number":5,"title":"Fox","state":"MERGED","isDraft":false,"url":"u5","baseRefName":"main","headRefName":"fox","isCrossRepository":false}`
	fork11 := `{"number":11,"title":"Fork lone","state":"MERGED","isDraft":false,"url":"u11","baseRefName":"main","headRefName":"lone","isCrossRepository":true}`
	own8 := `{"number":8,"title":"B","state":"OPEN","isDraft":false,"url":"u8","baseRefName":"layer-a","headRefName":"layer-b","isCrossRepository":false}`
	fork10 := `{"number":10,"title":"Fork A","state":"OPEN","isDraft":false,"url":"u10","baseRefName":"main","headRefName":"layer-a","isCrossRepository":true}`
	own3 := `{"number":3,"title":"A","state":"OPEN","isDraft":false,"url":"u3","baseRefName":"main","headRefName":"layer-a","isCrossRepository":false}`
	fork13 := `{"number":13,"title":"Fork contrib","state":"MERGED","isDraft":false,"url":"u13","baseRefName":"main","headRefName":"contrib","isCrossRepository":true}`
	fork42 := `{"number":42,"title":"Contrib","state":"OPEN","isDraft":false,"url":"u42","baseRefName":"main","headRefName":"contrib","isCrossRepository":true,"mergeStateStatus":"CLEAN","autoMergeRequest":null}`
	merged42 := strings.Replace(fork42, `"OPEN"`, `"MERGED"`, 1)
	script := `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$*" in
  "pr list --state all --head fox --limit 1 "*) echo '[` + fork9 + `]';;
  "pr list --state all --head fox "*) echo '[` + fork9 + `,` + own5 + `]';;
  "pr list --state merged --head fox "*) echo '[` + own5 + `]';;
  "pr list --state "*" --head lone "*) echo '[` + fork11 + `]';;
  "pr list --state all --head contrib "*) echo '[` + fork13 + `,` + fork42 + `]';;
  "pr list --state merged --head contrib "*) echo '[` + fork13 + `,` + merged42 + `]';;
  "pr list --state all --limit 200 "*) echo '[` + fork9 + `,` + fork42 + `,` + own8 + `,` + fork10 + `,` + own3 + `]';;
  "pr view 9 "*) echo '` + fork9 + `';;
  "pr view 42 "*) echo '` + fork42 + `';;
  "api graphql "*) echo '{"data":{"repository":{"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true,"autoMergeAllowed":false}}}';;
  "api repos/{owner}/{repo}/stacks?pull_request="*) echo "gh: Not Found (HTTP 404)" >&2; exit 1;;
  "pr merge "*) ;;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GH_LOG", log)
	return log
}

// Every lookup of a branch's PR (merge, land, pr, status, done and the
// stack walk) reads only this repository's, or the fork's PR the
// branch was checked out from: another fork's PR of the same name is
// a stranger's branch, as describe already treats it.
func TestPullRequestLookupsSkipForkPullRequests(t *testing.T) {
	fakeGhWithForks(t)
	dir := t.TempDir()
	mustGit(t, dir, "init", "-q")
	mustGit(t, dir, "config", "branch.contrib.merge", "refs/pull/42/head")

	if pr, err := findPullRequest(dir, "fox"); err != nil || pr == nil || pr.Number != 5 {
		t.Errorf("findPullRequest(fox) = %+v, %v, want #5", pr, err)
	}
	if probe := probePullRequest(dir, "fox"); probe.card == nil || probe.card.Number != 5 {
		t.Errorf("probePullRequest(fox) = %+v, want #5's card", probe)
	}
	if !branchHasMergedPR(dir, "fox") {
		t.Error("branchHasMergedPR(fox) = false, want #5")
	}

	if pr, err := findPullRequest(dir, "lone"); err != nil || pr != nil {
		t.Errorf("findPullRequest(lone) = %+v, %v, want no PR", pr, err)
	}
	if probe := probePullRequest(dir, "lone"); probe.card != nil || probe.reason != "" {
		t.Errorf("probePullRequest(lone) = %+v, want no PR", probe)
	}
	if branchHasMergedPR(dir, "lone") {
		t.Error("branchHasMergedPR(lone) = true, but only a fork's PR merged")
	}

	if pr, err := findPullRequest(dir, "contrib"); err != nil || pr == nil || pr.Number != 42 {
		t.Errorf("findPullRequest(contrib) = %+v, %v, want the checked-out #42", pr, err)
	}
	if probe := probePullRequest(dir, "contrib"); probe.card == nil || probe.card.Number != 42 {
		t.Errorf("probePullRequest(contrib) = %+v, want #42's card", probe)
	}
	if !branchHasMergedPR(dir, "contrib") {
		t.Error("branchHasMergedPR(contrib) = false, want the checked-out #42")
	}

	prs, err := listPullRequests(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := numbersOf(stackBelow(prs, 8, "main")), []int{3, 8}; !slices.Equal(got, want) {
		t.Errorf("stackBelow(8) = %v, want %v", got, want)
	}
}

// The app's merge goes by number. One that names a stranger's fork PR,
// alone or as the top of a stack, is refused before anything merges.
// The fork's PR its own branch here was checked out from merges.
func TestMergeByNumberRefusesAStrangersForkPullRequest(t *testing.T) {
	root := sandboxDataDir(t)
	upstream := seedRepo(t, root, "upstream")
	repo := filepath.Join(root, "repo")
	mustGit(t, root, "clone", "-q", upstream, repo)
	proj, err := registerProject(repo)
	if err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "config", "branch.contrib.merge", "refs/pull/42/head")
	log := fakeGhWithForks(t)
	ctx := resolveContext(proj.Path, []project{proj})

	for _, args := range [][]string{
		{"--project-id", proj.ID, "--number", "9"},
		{"--project-id", proj.ID, "--number", "9", "--stack"},
	} {
		code, err := cmdMerge(ctx, args)
		if code != 1 || errorKindOf(err) != "fork-pull-request" {
			t.Errorf("merge %v = %d, %v, want the fork-pull-request refusal", args, code, err)
		}
	}
	var merged []string
	for _, call := range ghCalls(t, log) {
		if strings.HasPrefix(call, "pr merge ") {
			merged = append(merged, call)
		}
	}
	if len(merged) > 0 {
		t.Errorf("a stranger's fork PR was merged: gh %q", merged)
	}

	for _, args := range [][]string{
		{"--project-id", proj.ID, "--number", "42"},
		{"--project-id", proj.ID, "--number", "42", "--stack"},
	} {
		if code, err := cmdMerge(ctx, args); code != 0 || err != nil {
			t.Errorf("merge %v = %d, %v, want the checked-out PR merged", args, code, err)
		}
	}
	merged = nil
	for _, call := range ghCalls(t, log) {
		if strings.HasPrefix(call, "pr merge ") {
			merged = append(merged, call)
		}
	}
	if len(merged) != 2 || !strings.HasPrefix(merged[0], "pr merge 42 ") || !strings.HasPrefix(merged[1], "pr merge 42 ") {
		t.Errorf("gh merge calls = %q, want #42 merged twice", merged)
	}
	// Checked out under another name (contrib was taken), #42 isn't
	// contrib's, and no lookup by contrib finds it, so neither does this.
	mustGit(t, repo, "config", "--unset", "branch.contrib.merge")
	mustGit(t, repo, "config", "branch.alice-contrib.merge", "refs/pull/42/head")
	if code, err := cmdMerge(ctx, []string{"--project-id", proj.ID, "--number", "42"}); code != 1 || errorKindOf(err) != "fork-pull-request" {
		t.Errorf("merge #42 checked out as alice-contrib = %d, %v, want the fork-pull-request refusal", code, err)
	}
}
