package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestOrderCarryOverSources(t *testing.T) {
	identities := []worktreeIdentity{
		{Name: "zebra", Branch: "zebra", Path: "/w/zebra"},
		{Name: "root", Branch: "main", Path: "/root", IsPrimary: true},
		{Name: "otter", Branch: "feat", Path: "/w/otter"},
		{Name: "newt", Branch: "newt", Path: "/w/newt"},
	}
	names := func(sources []worktreeIdentity) []string {
		out := make([]string, len(sources))
		for i, s := range sources {
			out[i] = s.Name
		}
		return out
	}
	// Base holder first, then primary, then the rest by name. The
	// destination is never a source.
	got := names(orderCarryOverSources(identities, "/w/newt", "feat"))
	if want := []string{"otter", "root", "zebra"}; !slices.Equal(got, want) {
		t.Fatalf("with base: got %v, want %v", got, want)
	}
	got = names(orderCarryOverSources(identities, "/w/newt", ""))
	if want := []string{"root", "otter", "zebra"}; !slices.Equal(got, want) {
		t.Fatalf("without base: got %v, want %v", got, want)
	}
	// A base nobody holds changes nothing.
	got = names(orderCarryOverSources(identities, "/w/newt", "main-2"))
	if want := []string{"root", "otter", "zebra"}; !slices.Equal(got, want) {
		t.Fatalf("unheld base: got %v, want %v", got, want)
	}
	if got := orderCarryOverSources(identities, "/w/newt", "feat"); got[1].IsPrimary != true || got[0].IsPrimary {
		t.Fatalf("IsPrimary flag misplaced: %+v", got)
	}
}

func TestApplyCarryOverFallsThroughSources(t *testing.T) {
	primary := t.TempDir()
	sibling := t.TempDir()
	dest := t.TempDir()
	if err := os.WriteFile(filepath.Join(primary, ".env"), []byte("A=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sibling, ".env"), []byte("A=sibling\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sibling, ".env.feature"), []byte("B=2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sources := []worktreeIdentity{
		{Name: "root", Path: primary, IsPrimary: true},
		{Name: "otter", Path: sibling},
	}
	writeFileT(t, filepath.Join(sibling, ".env.taken"), "T=1\n")
	writeFileT(t, filepath.Join(dest, ".env.taken"), "already here\n")
	entries := []carryOverEntry{
		{Path: ".env", Mode: "symlink"},
		// A symlink entry found only in a sibling is copied instead.
		{Path: ".env.feature", Mode: "symlink"},
		{Path: ".env.taken", Mode: "copy"},
		{Path: ".env.nowhere", Mode: "copy"},
	}
	report := applyCarryOver(sources, dest, entries)

	if report.Applied != 2 {
		t.Fatalf("applied = %d, want 2 (%+v)", report.Applied, report.Failures)
	}
	if got := readFileT(t, filepath.Join(dest, ".env")); got != "A=1\n" {
		t.Fatalf("primary should win for .env, got %q", got)
	}
	if info, err := os.Lstat(filepath.Join(dest, ".env")); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf(".env from the primary should be a symlink (%v, %v)", info, err)
	}
	if got := readFileT(t, filepath.Join(dest, ".env.feature")); got != "B=2\n" {
		t.Fatalf(".env.feature should come from the sibling, got %q", got)
	}
	if info, err := os.Lstat(filepath.Join(dest, ".env.feature")); err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf(".env.feature from a sibling must be a copy, not a link (%v, %v)", info, err)
	}
	want := carryOverSourced{Path: ".env.feature", Source: "otter", CopiedInstead: true}
	if len(report.Sourced) != 1 || report.Sourced[0] != want {
		t.Fatalf("sourced = %+v", report.Sourced)
	}
	if len(report.Failures) != 2 {
		t.Fatalf("failures = %+v", report.Failures)
	}
	if f := report.Failures[0]; f.Path != ".env.taken" || f.Source != "otter" || f.Reason != "Destination already exists" {
		t.Fatalf("taken failure = %+v", f)
	}
	if f := report.Failures[1]; f.Path != ".env.nowhere" || f.Source != "" || f.Reason != "Source missing in every checkout" {
		t.Fatalf("missing failure = %+v", f)
	}
}

// End to end through the real create path: an entry and a
// .worktreeinclude pattern that only exist in a sibling worktree still
// land in the new one, whether or not that sibling holds the base.
func TestCreateLifecycleCarriesOverFromSiblingWorktree(t *testing.T) {
	root := sandboxDataDir(t)
	repo := seedRepo(t, root, "repo")
	writeFileT(t, filepath.Join(repo, ".gitignore"), ".env*\n")
	mustGit(t, repo, "add", ".gitignore")
	mustGit(t, repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "ignore env")
	proj, err := registerProject(repo)
	if err != nil {
		t.Fatal(err)
	}
	writeFileT(t, projectConfigJSONPath(proj.ID),
		`{"defaultBranch":"main","carryOver":[{"path":".env.feat","mode":"copy"}]}`)

	// The sibling on branch feat: the manual entry's only copy, plus a
	// .worktreeinclude the primary doesn't have.
	otter, err := createWorktree(proj, "otter", "feat", "main", false)
	if err != nil {
		t.Fatal(err)
	}
	writeFileT(t, filepath.Join(otter.Path, ".env.feat"), "FEAT=1\n")
	writeFileT(t, filepath.Join(otter.Path, ".env.include"), "INC=1\n")
	writeFileT(t, filepath.Join(otter.Path, ".worktreeinclude"), ".env.include\n")

	for _, tc := range []struct{ name, base string }{
		{"newt", "feat"},
		{"koala", "main"},
	} {
		wt, err := createWorktree(proj, tc.name, tc.name, tc.base, false)
		if err != nil {
			t.Fatal(err)
		}
		if failures := runCreateLifecycle(proj, wt, tc.base); len(failures) != 0 {
			t.Fatalf("%s: lifecycle failures %+v", tc.name, failures)
		}
		if got := readFileT(t, filepath.Join(wt.Path, ".env.feat")); got != "FEAT=1\n" {
			t.Fatalf("%s (base %s): .env.feat = %q", tc.name, tc.base, got)
		}
		if got := readFileT(t, filepath.Join(wt.Path, ".env.include")); got != "INC=1\n" {
			t.Fatalf("%s (base %s): .env.include = %q", tc.name, tc.base, got)
		}
	}
}
