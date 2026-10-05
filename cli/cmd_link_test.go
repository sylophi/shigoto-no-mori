package main

// sm link: a worktree's deep link, addressed by name, by id or by cwd,
// the primary included.

import (
	"encoding/json"
	"testing"
)

func linkDoc(t *testing.T, ctx cliContext, args ...string) map[string]any {
	t.Helper()
	docs := captureJSON(t, func() {
		if code, err := cmdLink(ctx, args); code != 0 || err != nil {
			t.Fatalf("link %v: %d, %v", args, code, err)
		}
	})
	return decodeT[map[string]any](t, onlyDoc(t, docs))
}

func TestLinkPrintsTheWorktreesDeepLink(t *testing.T) {
	proj := autoPullSandbox(t)
	fox := createViaCmd(t, proj, "fox")
	ctx := cliContext{projects: []project{proj}}

	want := deepLinkOrigin + "/projects/" + proj.ID + "/worktrees/" + fox.ID
	for _, args := range [][]string{
		{"fox"},
		{"-p", proj.Name, "fox"},
		{"--project-id", proj.ID, "--worktree-id", fox.ID},
	} {
		doc := linkDoc(t, ctx, args...)
		if doc["url"] != want || doc["worktree"] != "fox" {
			t.Errorf("link %v answered %v, want url %s", args, doc, want)
		}
	}

	primaryID := worktreeIDFromPath(proj.Path)
	if doc := linkDoc(t, ctx, "--project-id", proj.ID, "--worktree-id", primaryID); doc["url"] != deepLinkOrigin+"/projects/"+proj.ID+"/worktrees/"+primaryID {
		t.Errorf("primary link = %v", doc)
	}

	if _, err := cmdLink(ctx, []string{"--project-id", proj.ID, "--worktree-id", "gone"}); errorKindOf(err) != "unknown-worktree" {
		t.Errorf("unknown worktree: %v", err)
	}
}

// Once the app has named the data dir, the link names its device, so
// it opens this machine's worktree from any device it's clicked on. An
// id the app would replace names no device and is left out.
func TestLinkNamesTheDevice(t *testing.T) {
	proj := autoPullSandbox(t)
	fox := createViaCmd(t, proj, "fox")
	ctx := cliContext{projects: []project{proj}}
	setDeviceID := func(id string) {
		t.Helper()
		if err := updateRegistryKey(deviceIDKey, func(json.RawMessage) (any, error) {
			return id, nil
		}); err != nil {
			t.Fatal(err)
		}
	}

	const id = "6f7c2f1e-9a41-4b7a-8f2e-3d5c1b0a9e88"
	tail := "/projects/" + proj.ID + "/worktrees/" + fox.ID
	setDeviceID(id)
	if got, want := linkDoc(t, ctx, "fox")["url"], deepLinkOrigin+"/devices/"+id+tail; got != want {
		t.Errorf("url = %v, want %s", got, want)
	}

	setDeviceID("not-a-uuid")
	if got, want := linkDoc(t, ctx, "fox")["url"], deepLinkOrigin+tail; got != want {
		t.Errorf("malformed id: url = %v, want %s", got, want)
	}
}
