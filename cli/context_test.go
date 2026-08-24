package main

// Tests for project ref resolution (resolveProject): names match
// case-insensitively, a name shared by two projects refuses to guess
// and names the paths instead, and a path ref addresses exactly one
// entry, including one whose directory is no longer there.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func projectsCtx(projects ...project) cliContext {
	return cliContext{projects: projects}
}

func TestResolveProjectByName(t *testing.T) {
	ctx := projectsCtx(project{ID: "A", Name: "fox", Path: "/repos/fox"})
	proj, err := resolveProject(ctx, "FOX")
	if err != nil || proj.ID != "A" {
		t.Fatalf("resolve FOX = %v, %v", proj, err)
	}
	if _, err := resolveProject(ctx, "badger"); err == nil {
		t.Error("unknown name resolved, want error")
	}
}

func TestResolveProjectAmbiguousNameNamesThePaths(t *testing.T) {
	ctx := projectsCtx(
		project{ID: "A", Name: "agent-snippets", Path: "/repos/one/agent-snippets"},
		project{ID: "B", Name: "agent-snippets", Path: "/repos/two/agent-snippets"},
	)
	_, err := resolveProject(ctx, "agent-snippets")
	if err == nil {
		t.Fatal("ambiguous name resolved, want error")
	}
	if code := exitCodeOf(err); code != 2 {
		t.Errorf("exit code = %d, want 2 (usage)", code)
	}
	// The error is the whole fix: it has to say what to type instead.
	for _, p := range ctx.projects {
		if !strings.Contains(err.Error(), p.Path) {
			t.Errorf("error %q doesn't name %s", err, p.Path)
		}
	}
	for _, ref := range []string{"/repos/two/agent-snippets", "/repos/two/agent-snippets/"} {
		proj, err := resolveProject(ctx, ref)
		if err != nil || proj.ID != "B" {
			t.Errorf("resolve %q = %v, %v, want B", ref, proj, err)
		}
	}
}

// The case that had no way out: a project whose repo moved away, so
// git can tell us nothing about the registered path.
func TestResolveProjectByPathOfVanishedDir(t *testing.T) {
	gone := filepath.Join(t.TempDir(), "agent-snippets")
	if err := os.MkdirAll(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	ctx := projectsCtx(
		project{ID: "A", Name: "agent-snippets", Path: gone},
		project{ID: "B", Name: "agent-snippets", Path: "/repos/two/agent-snippets"},
	)
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}
	proj, err := resolveProject(ctx, gone)
	if err != nil || proj.ID != "A" {
		t.Fatalf("resolve %s = %v, %v, want A", gone, proj, err)
	}
}

func TestResolveProjectUnknownPath(t *testing.T) {
	ctx := projectsCtx(project{ID: "A", Name: "fox", Path: "/repos/fox"})
	if _, err := resolveProject(ctx, filepath.Join(t.TempDir(), "nowhere")); err == nil {
		t.Error("path of no registered project resolved, want error")
	}
}

// Any directory inside a checkout names its project, the way `sm rm .`
// resolves a worktree.
func TestResolveProjectByPathInsideCheckout(t *testing.T) {
	dir := t.TempDir()
	deterministicGitEnv(t)
	runGitT(t, dir, "init")
	_, primary, err := locateRepo(dir)
	if err != nil {
		t.Fatalf("locateRepo: %v", err)
	}
	inner := filepath.Join(primary, "pkg", "inner")
	if err := os.MkdirAll(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	ctx := projectsCtx(project{ID: "A", Name: filepath.Base(primary), Path: primary})
	proj, err := resolveProject(ctx, inner)
	if err != nil || proj.ID != "A" {
		t.Fatalf("resolve %s = %v, %v, want A", inner, proj, err)
	}
}
