package main

// sm describe against real git in a temp SHIGOMORI_DATA_DIR: the
// title and description land in the worktree's data file beside what
// the app keeps there, reach the row, and each flag replaces only its
// own field. The seed repo has no remote, so no PR lookup runs.

import (
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

func TestDescribeRefusesMultilineTitle(t *testing.T) {
	proj := autoPullSandbox(t)
	createViaCmd(t, proj, "otter")
	ctx := resolveContext(proj.Path, []project{proj})
	if code, _ := cmdDescribe(ctx, []string{"otter", "-t", "one\ntwo"}); code != 2 {
		t.Fatalf("a two-line title exited %d", code)
	}
}
