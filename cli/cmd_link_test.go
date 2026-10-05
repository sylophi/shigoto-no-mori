package main

// sm link: a worktree's deep link, addressed by name, by id or by cwd,
// the primary included, under the device the app named the data dir.

import (
	"encoding/json"
	"testing"
)

func TestLinkPrintsTheWorktreesDeepLink(t *testing.T) {
	proj := autoPullSandbox(t)
	fox := createViaCmd(t, proj, "fox")
	ctx := cliContext{projects: []project{proj}}

	if _, err := cmdLink(ctx, []string{"fox"}); err == nil {
		t.Error("link before the app named the device succeeded")
	}

	const id = "6f7c2f1e-9a41-4b7a-8f2e-3d5c1b0a9e88"
	if err := updateRegistryKey(deviceIDKey, func(json.RawMessage) (any, error) {
		return id, nil
	}); err != nil {
		t.Fatal(err)
	}
	link := func(args ...string) map[string]any {
		t.Helper()
		docs := captureJSON(t, func() {
			if code, err := cmdLink(ctx, args); code != 0 || err != nil {
				t.Fatalf("link %v: %d, %v", args, code, err)
			}
		})
		return decodeT[map[string]any](t, onlyDoc(t, docs))
	}

	project := deepLinkOrigin + "/devices/" + id + "/projects/" + proj.ID
	for _, args := range [][]string{
		{"fox"},
		{"-p", proj.Name, "fox"},
		{"--project-id", proj.ID, "--worktree-id", fox.ID},
	} {
		doc := link(args...)
		if want := project + "/worktrees/" + fox.ID; doc["url"] != want || doc["worktree"] != "fox" {
			t.Errorf("link %v answered %v, want url %s", args, doc, want)
		}
	}

	primaryID := worktreeIDFromPath(proj.Path)
	if doc := link("--project-id", proj.ID, "--worktree-id", primaryID); doc["url"] != project+"/worktrees/"+primaryID {
		t.Errorf("primary link = %v", doc)
	}

	if _, err := cmdLink(ctx, []string{"--project-id", proj.ID, "--worktree-id", "gone"}); errorKindOf(err) != "unknown-worktree" {
		t.Errorf("unknown worktree: %v", err)
	}
}
