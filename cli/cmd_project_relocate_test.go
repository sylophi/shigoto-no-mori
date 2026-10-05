package main

// sm projects relocate: a repo moved by hand is found again, keeps its
// project id, and takes its worktrees and path-keyed state along.
// Against real git in a temp SHIGOMORI_DATA_DIR.

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestRelocateFollowsARepoMovedByHand(t *testing.T) {
	proj := autoPullSandbox(t)
	root := filepath.Dir(proj.Path)
	// A managed worktree stays where it is, and one inside the repo
	// (the in-project layout) moves along with it.
	fox := createViaCmd(t, proj, "fox")
	inside := filepath.Join(proj.Path, ".shigomori", "worktrees", "owl")
	runGitT(t, proj.Path, "worktree", "add", "-q", "-b", "owl", inside)
	owlID := worktreeIDFromPath(inside)
	primaryID := worktreeIDFromPath(proj.Path)
	for _, id := range []string{primaryID, owlID, fox.ID} {
		if err := setRegistryMark(autoPullKey, id, true); err != nil {
			t.Fatal(err)
		}
	}
	other, err := registerProject(seedRepo(t, root, "other"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := cliContext{projects: []project{proj, other}}
	if err := storeProjectOrder(ctx.projects, []string{other.ID, proj.ID}); err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(root, "renamed")
	if err := os.Rename(proj.Path, dest); err != nil {
		t.Fatal(err)
	}
	docs := captureJSON(t, func() {
		if code, err := cmdProject(ctx, []string{"relocate", "--project-id", proj.ID, dest}); code != 0 || err != nil {
			t.Fatalf("relocate: %d, %v", code, err)
		}
	})
	doc := decodeT[struct {
		OK      bool           `json:"ok"`
		Project projectRowJSON `json:"project"`
	}](t, onlyDoc(t, docs))
	if !doc.OK || doc.Project.ID != proj.ID || doc.Project.Path != dest ||
		doc.Project.Name != "renamed" || !doc.Project.PathExists {
		t.Fatalf("relocate answered %+v", doc)
	}
	stored, err := loadProjects()
	if err != nil {
		t.Fatal(err)
	}
	if i := slices.IndexFunc(stored, func(p project) bool { return p.ID == proj.ID }); i < 0 || stored[i].Path != dest {
		t.Fatalf("registry = %+v, want %s at %s", stored, proj.ID, dest)
	}

	// Both worktrees answer git again, from wherever they now are. The
	// managed one followed the rename to the base named after the new
	// folder, so it is still managed.
	newInside := filepath.Join(dest, ".shigomori", "worktrees", "owl")
	relocated := project{ID: proj.ID, Name: "renamed", Path: dest}
	newFox := filepath.Join(resolveWorktreeBase(dest, readProjectConfig(proj.ID)), "fox")
	for _, dir := range []string{newFox, newInside} {
		if _, err := runGit(dir, "status", "--porcelain"); err != nil {
			t.Errorf("git status in %s: %v", dir, err)
		}
	}
	if _, err := os.Stat(fox.Path); !os.IsNotExist(err) {
		t.Errorf("the managed worktree stayed at %s: %v", fox.Path, err)
	}
	if id := identityAt(t, relocated, newFox); id.IsExternal {
		t.Errorf("%s reads as external after the rename", newFox)
	}
	identityAt(t, relocated, newInside)

	// The marks keyed by path-derived ids follow the paths that moved.
	marks := readRegistryMarkSet(autoPullKey)
	for _, pair := range [][2]string{
		{primaryID, worktreeIDFromPath(dest)},
		{fox.ID, worktreeIDFromPath(newFox)},
		{owlID, worktreeIDFromPath(newInside)},
	} {
		if marks[pair[0]] || !marks[pair[1]] {
			t.Errorf("auto-pull mark: old %v new %v, want it moved", marks[pair[0]], marks[pair[1]])
		}
	}
	// And the project keeps its place in the manual order.
	_, order, err := loadProjectsAndOrder()
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{other.Path, dest}; !slices.Equal(order, want) {
		t.Errorf("order = %v, want %v", order, want)
	}
}

func TestRelocateRefusals(t *testing.T) {
	proj := autoPullSandbox(t)
	root := filepath.Dir(proj.Path)
	other, err := registerProject(seedRepo(t, root, "other"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := cliContext{projects: []project{proj, other}}
	notRepo := filepath.Join(root, "plain")
	if err := os.MkdirAll(notRepo, 0o755); err != nil {
		t.Fatal(err)
	}
	// While the repo is still where the project says, it isn't missing.
	elsewhere := seedRepo(t, root, "elsewhere")
	if code, err := cmdProject(ctx, []string{"relocate", "--project-id", proj.ID, elsewhere}); code == 0 || err == nil {
		t.Errorf("relocated a project whose repo is still there: %d, %v", code, err)
	}
	if err := os.Rename(proj.Path, filepath.Join(root, "gone")); err != nil {
		t.Fatal(err)
	}
	for _, dest := range []string{notRepo, other.Path} {
		if code, err := cmdProject(ctx, []string{"relocate", "--project-id", proj.ID, dest}); code == 0 || err == nil {
			t.Errorf("relocate to %s: %d, %v, want a refusal", dest, code, err)
		}
	}
	stored, err := loadProjects()
	if err != nil {
		t.Fatal(err)
	}
	if stored[0].Path != proj.Path {
		t.Errorf("a refused relocate moved the entry to %s", stored[0].Path)
	}
	terrier := project{ID: "T", Name: "t", Path: proj.Path, Source: "terrier"}
	if code, _ := cmdProject(cliContext{projects: []project{terrier}}, []string{"relocate", "--project-id", "T", other.Path}); code == 0 {
		t.Error("relocated a terrier-sourced project")
	}
	if code, _ := cmdProject(ctx, []string{"relocate"}); code != 2 {
		t.Errorf("bare relocate: exit %d, want 2", code)
	}
	if code, _ := cmdProject(ctx, []string{"relocate", "--project-id", proj.ID, "repo", elsewhere}); code != 2 {
		t.Errorf("a name beside --project-id: exit %d, want 2", code)
	}
}

// A worktree kept beside the repo moves with it when their parent
// folder moves whole.
func TestRelocateReconnectsSiblingsOfAMovedParent(t *testing.T) {
	root := sandboxDataDir(t)
	proj, err := registerProject(seedRepo(t, filepath.Join(root, "code"), "app"))
	if err != nil {
		t.Fatal(err)
	}
	sibling := filepath.Join(root, "code", "app-wt")
	runGitT(t, proj.Path, "worktree", "add", "-q", "-b", "wt", sibling)
	if err := os.Rename(filepath.Join(root, "code"), filepath.Join(root, "dev")); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(root, "dev", "app")
	ctx := cliContext{projects: []project{proj}}
	if code, err := cmdProject(ctx, []string{"relocate", "--project-id", proj.ID, dest}); code != 0 || err != nil {
		t.Fatalf("relocate: %d, %v", code, err)
	}
	moved := filepath.Join(root, "dev", "app-wt")
	if _, err := runGit(moved, "status", "--porcelain"); err != nil {
		t.Errorf("git status in %s: %v", moved, err)
	}
	identityAt(t, project{ID: proj.ID, Name: "app", Path: dest}, moved)
}
