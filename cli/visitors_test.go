package main

// The visitor tally (visitors.go): which names count, that a data dir
// without one starts from the villagers already living there, and that
// `--no-visit` leaves a copy uncounted. Against real git in a temp
// SHIGOMORI_DATA_DIR.

import (
	"encoding/json"
	"os"
	"testing"
)

func TestVisitorSlug(t *testing.T) {
	cases := map[string]string{
		"sheldon":   "sheldon",
		"sheldon-2": "sheldon",
		"tom-nook":  "tom-nook",
		"agent-s":   "agent-s",
		"agent-s-3": "agent-s",
		"fox":       "",
		"sheldon-x": "",
		"Sheldon":   "",
	}
	for name, want := range cases {
		if got := visitorSlug(name); got != want {
			t.Errorf("visitorSlug(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestVisitsSeedThenCount(t *testing.T) {
	proj := autoPullSandbox(t)
	ctx := resolveContext(proj.Path, []project{proj})
	// Living here before the tally existed.
	createWorktreeT(t, proj, "sheldon")
	createWorktreeT(t, proj, "fox")

	tally, err := readVisits(ctx.projects)
	if err != nil {
		t.Fatal(err)
	}
	if len(tally) != 1 || tally["sheldon"].Count != 1 || tally["sheldon"].First == 0 {
		t.Fatalf("seeded tally = %+v, want sheldon once", tally)
	}

	createViaCmd(t, proj, "sheldon-2")
	createViaCmd(t, proj, "ace")
	if code, err := cmdCreate(ctx, []string{"--no-cd", "--no-setup", "--no-visit", "ace-2"}); code != 0 || err != nil {
		t.Fatalf("create ace-2: %d, %v", code, err)
	}

	tally, err = readVisits(ctx.projects)
	if err != nil {
		t.Fatal(err)
	}
	if tally["sheldon"].Count != 2 || tally["ace"].Count != 1 || len(tally) != 2 {
		t.Fatalf("tally = %+v, want sheldon twice and ace once", tally)
	}
	if tally["sheldon"].Last < tally["sheldon"].First {
		t.Fatalf("sheldon's last visit is before the first: %+v", tally["sheldon"])
	}
}

// A tally key written as null reads as empty and takes the next visit,
// rather than failing the create.
func TestVisitsNullTally(t *testing.T) {
	proj := autoPullSandbox(t)
	if err := updateFileKey(visitsPath(), villagersKey, func(json.RawMessage) (any, error) {
		return json.RawMessage("null"), nil
	}); err != nil {
		t.Fatal(err)
	}
	createViaCmd(t, proj, "ace")
	tally, err := readVisits([]project{proj})
	if err != nil || tally["ace"].Count != 1 {
		t.Fatalf("tally = %+v, %v, want ace once", tally, err)
	}
}

// Reading never writes: a data dir without a tally shows its residents
// and keeps no file until a create.
func TestVisitsReadWritesNothing(t *testing.T) {
	proj := autoPullSandbox(t)
	createWorktreeT(t, proj, "sheldon")
	tally, err := readVisits([]project{proj})
	if err != nil || tally["sheldon"].Count != 1 {
		t.Fatalf("tally = %+v, %v, want sheldon once", tally, err)
	}
	if _, err := os.Stat(visitsPath()); !os.IsNotExist(err) {
		t.Fatalf("visits.json after a read: %v, want none", err)
	}
}

func TestVisitsStartWithTheFirstCreate(t *testing.T) {
	proj := autoPullSandbox(t)
	createWorktreeT(t, proj, "sheldon")
	// The tally's first write is a create: it starts from the residents,
	// the new one among them, and counts nobody twice.
	createViaCmd(t, proj, "ace")
	tally, err := readVisits([]project{proj})
	if err != nil {
		t.Fatal(err)
	}
	if tally["sheldon"].Count != 1 || tally["ace"].Count != 1 || len(tally) != 2 {
		t.Fatalf("tally = %+v, want sheldon and ace once each", tally)
	}
}

// A worktree made without going through `sm create`, so the tally
// never hears of it.
func createWorktreeT(t *testing.T, proj project, name string) {
	t.Helper()
	if _, err := createWorktree(proj, name, "", "", false); err != nil {
		t.Fatalf("createWorktree %s: %v", name, err)
	}
}
