package main

// sm link: a worktree's deep link, addressed by name, by id or by cwd,
// the primary included.

import "testing"

func TestLinkPrintsTheWorktreesDeepLink(t *testing.T) {
	proj := autoPullSandbox(t)
	fox := createViaCmd(t, proj, "fox")
	ctx := cliContext{projects: []project{proj}}
	link := func(args ...string) map[string]any {
		t.Helper()
		docs := captureJSON(t, func() {
			if code, err := cmdLink(ctx, args); code != 0 || err != nil {
				t.Fatalf("link %v: %d, %v", args, code, err)
			}
		})
		return decodeT[map[string]any](t, onlyDoc(t, docs))
	}

	want := deepLinkOrigin + "/projects/" + proj.ID + "/worktrees/" + fox.ID
	for _, args := range [][]string{
		{"fox"},
		{"-p", proj.Name, "fox"},
		{"--project-id", proj.ID, "--worktree-id", fox.ID},
	} {
		doc := link(args...)
		if doc["url"] != want || doc["worktree"] != "fox" {
			t.Errorf("link %v answered %v, want url %s", args, doc, want)
		}
	}

	primaryID := worktreeIDFromPath(proj.Path)
	if doc := link("--project-id", proj.ID, "--worktree-id", primaryID); doc["url"] != deepLinkOrigin+"/projects/"+proj.ID+"/worktrees/"+primaryID {
		t.Errorf("primary link = %v", doc)
	}

	if _, err := cmdLink(ctx, []string{"--project-id", proj.ID, "--worktree-id", "gone"}); errorKindOf(err) != "unknown-worktree" {
		t.Errorf("unknown worktree: %v", err)
	}
}
