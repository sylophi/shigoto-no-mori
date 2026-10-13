package main

// sm describe against real git in a temp SHIGOMORI_DATA_DIR: the
// title and description land in the worktree's data file beside what
// the app keeps there, reach the row, and each flag replaces only its
// own field. The seed repo has no remote, so no PR lookup runs, except
// in the clone that plays one with a fake gh.

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func describeVia(t *testing.T, proj project, args ...string) {
	t.Helper()
	ctx := resolveContext(proj.Path, []project{proj})
	if code, err := cmdDescribe(ctx, args); code != 0 || err != nil {
		t.Fatalf("describe %v: %d, %v", args, code, err)
	}
}

func TestDescribeSetsTitleAndDescription(t *testing.T) {
	proj := autoPullSandbox(t)
	wt := createViaCmd(t, proj, "otter")
	writeFileT(t, worktreeDataPath(proj.ID, wt.ID), `{"ports":[{"name":"api","port":4000}]}`)

	describeVia(t, proj, "otter", "-t", "  Worktree titles  ", "-d", "Names the work\nbefore the PR.")
	row := buildWorktree(proj, wt, loadBuildContext(proj))
	if row.Title != "Worktree titles" || row.Description != "Names the work\nbefore the PR." {
		t.Fatalf("row carries %q / %q", row.Title, row.Description)
	}
	if data := readFileT(t, worktreeDataPath(proj.ID, wt.ID)); !strings.Contains(data, `"api"`) {
		t.Fatalf("the describe dropped the app's ports: %s", data)
	}
	first := readWorktreeDescription(proj.ID, wt.ID).DescribedAt
	if first == 0 {
		t.Fatal("no describedAt stamped")
	}

	// A title alone keeps the description, and an empty description
	// clears it.
	describeVia(t, proj, "otter", "--title", "Titles and descriptions")
	if got := readWorktreeDescription(proj.ID, wt.ID); got.Title != "Titles and descriptions" || got.Description != "Names the work\nbefore the PR." {
		t.Fatalf("a title-only describe left %+v", got)
	}
	describeVia(t, proj, "otter", "-d", "")
	if got := readWorktreeDescription(proj.ID, wt.ID); got.Title != "Titles and descriptions" || got.Description != "" {
		t.Fatalf("clearing the description left %+v", got)
	}
}

// With an open PR of its own, describe edits the PR and leaves the
// worktree's own pair as it was. A PR's title can't be cleared.
func TestDescribeEditsTheOpenPullRequest(t *testing.T) {
	root := sandboxDataDir(t)
	upstream := seedRepo(t, root, "upstream")
	repo := filepath.Join(root, "repo")
	mustGit(t, root, "clone", "-q", upstream, repo)
	proj, err := registerProject(repo)
	if err != nil {
		t.Fatal(err)
	}
	wt := createViaCmd(t, proj, "otter")
	describeVia(t, proj, "otter", "-t", "Before the PR")

	bin := t.TempDir()
	log := filepath.Join(bin, "gh.log")
	script := `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$GH_FAIL" in
  auth) echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 1;;
  down) echo "HTTP 502: Bad Gateway" >&2; exit 1;;
esac
case "$*" in
  "pr list --state open --head otter "*) echo '[{"number":7,"url":"u7","title":"Otter","body":"","isCrossRepository":false}]';;
  "pr edit "*) ;;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GH_LOG", log)

	describeVia(t, proj, "otter", "-t", "Otters", "-d", "- What they do.")
	describeVia(t, proj, "otter", "-d", "")
	calls := ghCalls(t, log)
	for _, want := range []string{"pr edit 7 --title=Otters --body=- What they do.", "pr edit 7 --body="} {
		if !slices.Contains(calls, want) {
			t.Errorf("no %q among gh calls %q", want, calls)
		}
	}
	if got := readWorktreeDescription(proj.ID, wt.ID); got.Title != "Before the PR" || got.Description != "" {
		t.Fatalf("editing the PR changed the worktree's own pair: %+v", got)
	}

	ctx := resolveContext(proj.Path, []project{proj})
	if code, _ := cmdDescribe(ctx, []string{"otter", "-t", ""}); code != 2 {
		t.Fatalf("clearing the PR's title exited %d", code)
	}

	// A lookup GitHub failed could have missed the PR, so nothing is
	// written. A gh that isn't signed in can't show one anywhere.
	t.Setenv("GH_FAIL", "down")
	if code, _ := cmdDescribe(ctx, []string{"otter", "-t", "Lost"}); code != 1 {
		t.Fatalf("describe with GitHub down exited %d", code)
	}
	if got := readWorktreeDescription(proj.ID, wt.ID); got.Title != "Before the PR" {
		t.Fatalf("describe with GitHub down wrote %+v", got)
	}
	t.Setenv("GH_FAIL", "auth")
	describeVia(t, proj, "otter", "-t", "Signed out")
	if got := readWorktreeDescription(proj.ID, wt.ID); got.Title != "Signed out" {
		t.Fatalf("describe with gh signed out left %+v", got)
	}
}

func TestDescribeRefusesMultilineTitle(t *testing.T) {
	proj := autoPullSandbox(t)
	createViaCmd(t, proj, "otter")
	ctx := resolveContext(proj.Path, []project{proj})
	if code, _ := cmdDescribe(ctx, []string{"otter", "-t", "one\ntwo"}); code != 2 {
		t.Fatalf("a two-line title exited %d", code)
	}
}

// A move out of the layout makes the worktree external, which keeps no
// title, and adopting it back carries the title along.
func TestAdoptCarriesTheTitle(t *testing.T) {
	proj := autoPullSandbox(t)
	wt := createViaCmd(t, proj, "otter")
	describeVia(t, proj, "otter", "-t", "Keep me")
	moved, err := moveWorktree(proj, wt, filepath.Join(t.TempDir(), "outside"))
	if err != nil {
		t.Fatal(err)
	}
	if !moved.IsExternal || moved.Title != "" {
		t.Fatalf("an external worktree's row carries %q (external %v)", moved.Title, moved.IsExternal)
	}
	ctx := resolveContext(proj.Path, []project{proj})
	if code, err := cmdAdopt(ctx, []string{moved.Path}); code != 0 || err != nil {
		t.Fatalf("adopt: %d, %v", code, err)
	}
	identities, err := listWorktreeIdentities(proj)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range identities {
		if id.Branch == "otter" {
			if id.IsExternal {
				t.Fatalf("adopt left %s external", id.Path)
			}
			if got := readWorktreeDescription(proj.ID, id.ID).Title; got != "Keep me" {
				t.Fatalf("the adopted worktree's title is %q", got)
			}
			return
		}
	}
	t.Fatal("no worktree on otter after adopt")
}

func TestDescribeKeepsAFirstLineIndent(t *testing.T) {
	proj := autoPullSandbox(t)
	wt := createViaCmd(t, proj, "otter")
	describeVia(t, proj, "otter", "-d", "\n    indented code\nnext\n\n")
	if got := readWorktreeDescription(proj.ID, wt.ID).Description; got != "    indented code\nnext" {
		t.Fatalf("description stored as %q", got)
	}
	ctx := resolveContext(proj.Path, []project{proj})
	if code, _ := cmdDescribe(ctx, []string{"otter", "-t", "tab\there"}); code != 2 {
		t.Fatalf("a title with a tab exited %d", code)
	}
}

func TestGhProbeReasonNamesAMissingGitHubRemote(t *testing.T) {
	stderr := "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`"
	if got := ghProbeReason(stderr); got != ghNoGitHubRemote {
		t.Fatalf("reason %q", got)
	}
}
